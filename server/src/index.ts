import dgram from 'node:dgram';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildArmDisarm,
  buildEmergencyStop,
  buildManualControl,
  buildRcChannelsOverride,
  buildSetMode,
  buildMissionCount,
  buildMissionItemInt,
  buildMissionDoJumpInt,
  buildMissionClearAll,
  buildMissionSetCurrent,
  buildMissionRequestList,
  buildMissionRequestInt,
  buildMissionAck,
  decodeFrames,
  parseBatteryStatus,
  parseCommandAck,
  parseGlobalPositionInt,
  parseGpsRawInt,
  parseGpsStatus,
  parseHeartbeat,
  parseStatusText,
  parseSysStatus,
  parseVfrHud,
  parseMissionRequest,
  parseMissionCount,
  parseMissionItem,
  parseMissionItemInt,
  parseMissionAck,
  parseMissionCurrent,
  parseMissionItemReached
} from './mavlink.js';
import type { MavlinkFrame, ParsedMissionItem } from './mavlink.js';
import { UsvStore } from './state.js';
import type { ManualControlInput, UsvState, Waypoint, MissionItem } from './types.js';

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 4000);
const UDP_PORT = Number(process.env.UDP_PORT ?? 14550);
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MS ?? 5000);
const CONTROL_TIMEOUT_MS = Number(process.env.CONTROL_TIMEOUT_MS ?? 500);

const store = new UsvStore(OFFLINE_AFTER_MS);
const udp = dgram.createSocket('udp4');
const clients = new Set<WebSocket>();

let lastManualInputAt = 0;
let lastSentZeroAt = 0;
let missionUploadInProgress = false;
let pendingMissionItems: MissionItem[] = [];
let lastUploadMissionItems: MissionItem[] = [];
let missionUploadStartTimer: NodeJS.Timeout | null = null;
let missionUploadTimer: NodeJS.Timeout | null = null;
const MISSION_UPLOAD_TIMEOUT_MS = 10_000;
const MISSION_CLEAR_BEFORE_UPLOAD_DELAY_MS = 300;
let missionReadbackInProgress = false;
let missionReadbackReason = '';
let missionReadbackExpectedCount = 0;
let missionReadbackNextSeq = 0;
let missionReadbackItems = new Map<number, ParsedMissionItem>();
let missionReadbackTimer: NodeJS.Timeout | null = null;
const MISSION_READBACK_TIMEOUT_MS = 8_000;

udp.on('message', (packet, remote) => {
  const frames = decodeFrames(packet);
  for (const frame of frames) {
    const state = store.markSeen(frame.systemId, frame.componentId, {
      address: remote.address,
      port: remote.port
    });

    switch (frame.messageId) {
      case 0: {
        const heartbeat = parseHeartbeat(frame.payload);
        if (heartbeat) {
          store.patch(heartbeat);
        }
        break;
      }
      case 1: {
        const sys = parseSysStatus(frame.payload);
        if (sys) store.patch(sys);
        break;
      }
      case 24: {
        const gps = parseGpsRawInt(frame.payload);
        if (gps) store.patch(gps);
        break;
      }
      case 25: {
        const gpsStatus = parseGpsStatus(frame.payload);
        if (gpsStatus) store.patch(gpsStatus);
        break;
      }
      case 33: {
        const position = parseGlobalPositionInt(frame.payload);
        if (position) store.patch(position);
        break;
      }
      case 74: {
        const hud = parseVfrHud(frame.payload);
        if (hud) store.patch(hud);
        break;
      }
      case 77: {
        const ack = parseCommandAck(frame.payload);
        if (ack) {
          broadcast('usv.statusText', {
            deviceId: state.deviceId,
            severity: ack.result === 0 ? 6 : 4,
            text: `COMMAND_ACK sys=${frame.systemId} comp=${frame.componentId} command=${ack.command} result=${ack.resultName}`
          });
        }
        break;
      }
      case 147: {
        const battery = parseBatteryStatus(frame.payload);
        if (battery) store.patch(battery);
        break;
      }
      case 253: {
        const status = parseStatusText(frame.payload);
        if (status?.text) {
          broadcast('usv.statusText', { deviceId: state.deviceId, ...status });
        }
        break;
      }
      // ==================== 航线消息处理 ====================
      case 39: {
        const item = parseMissionItem(frame.payload);
        if (item && missionReadbackInProgress) {
          logMissionRxFrame(frame, `MISSION_ITEM seq=${item.seq}`);
          handleMissionReadbackItem(frame.systemId, frame.componentId, item);
        }
        break;
      }
      case 40:
      case 51: { // MISSION_REQUEST / MISSION_REQUEST_INT - 飞控请求航点
        const request = parseMissionRequest(frame.payload);
        if (request && missionUploadInProgress) {
          logMissionRxFrame(frame, `MISSION_REQUEST seq=${request.sequence}`);
          handleMissionRequest(frame.systemId, frame.componentId, request.sequence);
        }
        break;
      }
      case 44: {
        const count = parseMissionCount(frame.payload);
        if (count && missionReadbackInProgress) {
          logMissionRxFrame(frame, `MISSION_COUNT count=${count.count}`);
          handleMissionReadbackCount(frame.systemId, frame.componentId, count.count);
        }
        break;
      }
      case 42: { // MISSION_CURRENT - 当前航点
        const current = parseMissionCurrent(frame.payload);
        if (current) {
          store.setCurrentWaypoint(current.seq);
          broadcast('mission.current', { seq: current.seq });
        }
        break;
      }
      case 46: { // MISSION_ITEM_REACHED - 航点到达
        const reached = parseMissionItemReached(frame.payload);
        if (reached) {
          broadcast('mission.reached', { seq: reached.seq });
        }
        break;
      }
      case 47: { // MISSION_ACK - 航线上传确认
        const ack = parseMissionAck(frame.payload);
        if (ack) {
          logMissionRxFrame(frame, `MISSION_ACK type=${ack.type} result=${ack.result}`);
          handleMissionAck(ack.type, ack.result);
        }
        break;
      }
      case 73: {
        const item = parseMissionItemInt(frame.payload);
        if (item && missionReadbackInProgress) {
          logMissionRxFrame(frame, `MISSION_ITEM_INT seq=${item.seq}`);
          handleMissionReadbackItem(frame.systemId, frame.componentId, item);
        }
        break;
      }
      default:
        break;
    }
  }

  if (frames.length > 0) broadcastState();
});

udp.on('listening', () => {
  const address = udp.address();
  console.log(`UDP MAVLink2 listening on ${address.address}:${address.port}`);
});

udp.bind(UDP_PORT, '0.0.0.0');

// ==================== 航线处理函数 ====================

function handleMissionRequest(targetSystem: number, targetComponent: number, sequence: number): void {
  if (sequence < pendingMissionItems.length) {
    const item = pendingMissionItems[sequence];
    const frame = item.type === 'doJump'
      ? buildMissionDoJumpInt(targetSystem, targetComponent, sequence, item.target, item.repeat)
      : buildMissionItemInt(targetSystem, targetComponent, sequence, item.lat, item.lng, item.altitude ?? 0, 16, item.type === 'home' ? 0 : 6);
    sendMissionFrame(frame, item.type === 'doJump' ? `MISSION_DO_JUMP_INT seq=${sequence}` : `MISSION_ITEM_INT seq=${sequence}`);
    console.log(item.type === 'doJump'
      ? `Sent DO_JUMP ${sequence}: target=${item.target} repeat=${item.repeat}`
      : `Sent waypoint ${sequence} as MISSION_ITEM_INT: ${item.lat}, ${item.lng}`);
  }
}

function sendMissionFrame(frame: Buffer, label: string): void {
  const remote = store.getState().remote;
  if (!remote) return;
  const messageId = frame.length >= 10 ? frame[7] | (frame[8] << 8) | (frame[9] << 16) : -1;
  const txSeq = frame.length >= 5 ? frame[4] : -1;
  console.log(`TX MAVLink ${label} msg=${messageId} txSeq=${txSeq} bytes=${frame.length} to=${remote.address}:${remote.port} hex=${frame.toString('hex')}`);
  udp.send(frame, remote.port, remote.address);
}

function logMissionRxFrame(frame: MavlinkFrame, label: string): void {
  console.log(`RX MAVLink ${label} msg=${frame.messageId} mavlink=${frame.version} rxSeq=${frame.sequence} sys=${frame.systemId} comp=${frame.componentId} bytes=${frame.raw.length} hex=${frame.raw.toString('hex')}`);
}

function startMissionReadback(reason: string): void {
  const state = store.getState();
  if (!state.online || !state.remote) {
    console.log(`Mission readback skipped: USV offline (${reason})`);
    return;
  }

  clearMissionReadbackTimer();
  missionReadbackInProgress = true;
  missionReadbackReason = reason;
  missionReadbackExpectedCount = 0;
  missionReadbackNextSeq = 0;
  missionReadbackItems = new Map<number, ParsedMissionItem>();

  sendMissionFrame(buildMissionRequestList(state.systemId, state.componentId || 1), `MISSION_REQUEST_LIST reason=${reason}`);
  missionReadbackTimer = setTimeout(() => {
    finishMissionReadback(`timeout waiting for readback (${reason})`);
  }, MISSION_READBACK_TIMEOUT_MS);
}

function handleMissionReadbackCount(targetSystem: number, targetComponent: number, count: number): void {
  if (!missionReadbackInProgress) return;
  missionReadbackExpectedCount = count;
  missionReadbackNextSeq = 0;
  console.log(`Mission readback count=${count} reason=${missionReadbackReason}`);
  if (count === 0) {
    sendMissionFrame(buildMissionAck(targetSystem, targetComponent, 0), 'MISSION_ACK readback empty');
    finishMissionReadback('complete');
    return;
  }
  requestMissionReadbackItem(targetSystem, targetComponent, 0);
}

function handleMissionReadbackItem(targetSystem: number, targetComponent: number, item: ParsedMissionItem): void {
  if (!missionReadbackInProgress) return;
  missionReadbackItems.set(item.seq, item);
  console.log(`Mission readback item seq=${item.seq} command=${item.command} frame=${item.frame} current=${item.current} autocontinue=${item.autocontinue} lat=${item.lat.toFixed(7)} lng=${item.lng.toFixed(7)} alt=${item.altitude.toFixed(2)}`);

  const nextSeq = item.seq + 1;
  if (nextSeq >= missionReadbackExpectedCount) {
    sendMissionFrame(buildMissionAck(targetSystem, targetComponent, 0), 'MISSION_ACK readback complete');
    finishMissionReadback('complete');
    return;
  }
  missionReadbackNextSeq = nextSeq;
  requestMissionReadbackItem(targetSystem, targetComponent, nextSeq);
}

function requestMissionReadbackItem(targetSystem: number, targetComponent: number, sequence: number): void {
  sendMissionFrame(buildMissionRequestInt(targetSystem, targetComponent, sequence), `MISSION_REQUEST_INT readback seq=${sequence}`);
}

function finishMissionReadback(status: string): void {
  if (!missionReadbackInProgress) return;
  clearMissionReadbackTimer();
  const items = [...missionReadbackItems.values()].sort((a, b) => a.seq - b.seq);
  console.log(`Mission readback ${status}: expected=${missionReadbackExpectedCount} received=${items.length} reason=${missionReadbackReason}`);
  for (const item of items) {
    console.log(`Mission readback summary seq=${item.seq} command=${item.command} lat=${item.lat.toFixed(7)} lng=${item.lng.toFixed(7)} alt=${item.altitude.toFixed(2)}`);
  }
  missionReadbackInProgress = false;
  const reason = missionReadbackReason;
  missionReadbackReason = '';
  missionReadbackExpectedCount = 0;
  missionReadbackNextSeq = 0;
  missionReadbackItems = new Map<number, ParsedMissionItem>();

  if (reason.startsWith('upload-')) {
    if (status === 'complete' && missionItemsMatchReadback(lastUploadMissionItems, items)) {
      completeMissionWrite('readback-match');
    } else if (store.getMissionState().status === 'uploading') {
      store.setMissionStatus('idle');
      pendingMissionItems = [];
      broadcast('mission.uploaded', { success: false, result: 'readback-mismatch' });
      console.log('Mission write failed: readback mismatch');
    }
  }
}

function clearMissionReadbackTimer(): void {
  if (!missionReadbackTimer) return;
  clearTimeout(missionReadbackTimer);
  missionReadbackTimer = null;
}

function completeMissionWrite(source: string): void {
  const items = lastUploadMissionItems.length > 0 ? lastUploadMissionItems : pendingMissionItems;
  missionUploadInProgress = false;
  pendingMissionItems = [];
  store.setMissionWaypoints(items);
  store.setMissionStatus('ready');
  broadcast('mission.uploaded', { success: true, source });
  console.log(`Mission waypoints written successfully via ${source}; ready to start`);
}

function missionItemsMatchReadback(expected: MissionItem[], actual: ParsedMissionItem[]): boolean {
  if (expected.length === 0 || actual.length !== expected.length) return false;
  const bySeq = new Map(actual.map((item) => [item.seq, item]));
  for (let seq = 0; seq < expected.length; seq += 1) {
    const expectedItem = expected[seq];
    const actualItem = bySeq.get(seq);
    if (!actualItem) return false;
    if (expectedItem.type === 'doJump') {
      if (actualItem.command !== 177) return false;
      if (Math.round(actualItem.param1) !== expectedItem.target) return false;
      if (Math.round(actualItem.param2) !== expectedItem.repeat) return false;
      continue;
    }
    if (actualItem.command !== 16) return false;
    if (expectedItem.type === 'home') continue;
    if (Math.abs(actualItem.lat - expectedItem.lat) > 0.00001) return false;
    if (Math.abs(actualItem.lng - expectedItem.lng) > 0.00001) return false;
  }
  return true;
}

function handleMissionAck(type: number, result: number): void {
  if (!missionUploadInProgress) return;
  clearMissionUploadTimers();

  if (type === 0 && result === 0) { // MAV_MISSION_ACCEPTED
    completeMissionWrite('mission-ack');
    startMissionReadback('upload-ack');
  } else {
    missionUploadInProgress = false;
    pendingMissionItems = [];
    store.setMissionStatus('idle');
    broadcast('mission.uploaded', { success: false, result });
    console.log(`Mission upload failed: type=${type} result=${result}`);
    startMissionReadback(`upload-ack-failed-${result}`);
  }
}

function uploadMission(waypoints: Waypoint[], loopCount = 1): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };
  if (waypoints.length === 0) return { ok: false, message: 'No waypoints' };

  const missionItems = buildMissionItems(waypoints, loopCount, state);
  const remote = state.remote;
  missionUploadInProgress = false;
  pendingMissionItems = missionItems;
  lastUploadMissionItems = missionItems;
  store.setMissionStatus('uploading');

  clearMissionUploadTimers();
  sendMissionFrame(buildMissionClearAll(state.systemId, state.componentId || 1), 'MISSION_CLEAR_ALL before upload');
  console.log(`Clearing existing mission before upload (${missionItems.length} new items)`);
  missionUploadStartTimer = setTimeout(() => {
    missionUploadStartTimer = null;
    if (pendingMissionItems !== missionItems) return;
    missionUploadInProgress = true;
    startMissionUploadTimeout();
    const countFrame = buildMissionCount(state.systemId, state.componentId || 1, missionItems.length);
    sendMissionFrame(countFrame, `MISSION_COUNT count=${missionItems.length}`);
    console.log(`Uploading mission with ${missionItems.length} items (${waypoints.length} waypoints, loop=${loopCount})`);
  }, MISSION_CLEAR_BEFORE_UPLOAD_DELAY_MS);

  return { ok: true, message: 'Mission upload started' };
}

function startMissionUploadTimeout(): void {
  clearMissionUploadTimeout();
  missionUploadTimer = setTimeout(() => {
    if (!missionUploadInProgress) return;
    missionUploadInProgress = false;
    console.log(`Mission upload timeout after ${MISSION_UPLOAD_TIMEOUT_MS}ms waiting for MISSION_ACK`);
    startMissionReadback('upload-timeout');
  }, MISSION_UPLOAD_TIMEOUT_MS);
}

function clearMissionUploadTimers(): void {
  if (missionUploadStartTimer) {
    clearTimeout(missionUploadStartTimer);
    missionUploadStartTimer = null;
  }
  clearMissionUploadTimeout();
}

function clearMissionUploadTimeout(): void {
  if (!missionUploadTimer) return;
  clearTimeout(missionUploadTimer);
  missionUploadTimer = null;
}

function buildMissionItems(waypoints: Waypoint[], loopCount: number, state: UsvState): MissionItem[] {
  const sanitizedLoopCount = Math.max(1, Math.min(10, Math.round(loopCount || 1)));
  const homeLat = state.lat ?? waypoints[0].lat;
  const homeLng = state.lng ?? waypoints[0].lng;
  const items: MissionItem[] = [{
    type: 'home',
    order: 0,
    lat: homeLat,
    lng: homeLng,
    altitude: state.gpsAltitude ?? 0
  }];

  items.push(...waypoints.map((point, index) => ({
    ...point,
    order: index + 1,
    type: 'waypoint' as const
  })));

  if (sanitizedLoopCount > 1 && waypoints.length > 0) {
    items.push({
      type: 'doJump',
      order: items.length + 1,
      target: 1,
      repeat: sanitizedLoopCount - 1
    });
  }

  return items;
}

function pauseMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  // 切换到 HOLD 模式暂停任务
  for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'hold', state.autopilot)) {
    sendMissionFrame(frame, 'SET_MODE hold');
  }
  store.setMissionStatus('paused');
  broadcast('mission.paused', {});
  return { ok: true, message: 'Mission paused' };
}

function startMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };
  const mission = store.getMissionState();
  if (mission.totalWaypoints <= 1 || mission.status !== 'ready') {
    return { ok: false, message: 'Mission waypoints are not ready' };
  }

  sendMissionFrame(buildMissionSetCurrent(state.systemId, state.componentId || 1, 1), 'MISSION_SET_CURRENT seq=1');
  for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'mission', state.autopilot)) {
    sendMissionFrame(frame, 'SET_MODE mission');
  }
  store.setMissionStatus('active');
  broadcast('mission.started', {});
  return { ok: true, message: 'Mission started' };
}

function resumeMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  // 切换回 AUTO 模式继续任务
  for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'mission', state.autopilot)) {
    sendMissionFrame(frame, 'SET_MODE mission');
  }
  store.setMissionStatus('active');
  broadcast('mission.resumed', {});
  return { ok: true, message: 'Mission resumed' };
}

function clearMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  const frame = buildMissionClearAll(state.systemId, state.componentId || 1);
  missionUploadInProgress = false;
  pendingMissionItems = [];
  lastUploadMissionItems = [];
  clearMissionUploadTimers();
  sendMissionFrame(frame, 'MISSION_CLEAR_ALL');
  store.clearMission();
  broadcast('mission.cleared', {});
  return { ok: true, message: 'Mission cleared' };
}

function requestMissionReadback(reason: string): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };
  startMissionReadback(reason);
  return { ok: true, message: 'Mission readback requested' };
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/state') {
    return sendJson(res, 200, { code: 200, data: publicState() });
  }

  if (url.pathname === '/api/mission') {
    return sendJson(res, 200, { code: 200, data: store.getMissionState() });
  }

  if (url.pathname === '/api/mission/upload' && req.method === 'POST') {
    const body = await readBody(req) as { waypoints?: Waypoint[]; loopCount?: number };
    console.log(`HTTP mission upload requested: waypoints=${body.waypoints?.length ?? 0}, loop=${body.loopCount ?? 1}`);
    const result = uploadMission(body.waypoints || [], body.loopCount);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/mission/pause' && req.method === 'POST') {
    const result = pauseMission();
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/mission/start' && req.method === 'POST') {
    const result = startMission();
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/mission/resume' && req.method === 'POST') {
    const result = resumeMission();
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/mission/clear' && req.method === 'POST') {
    const result = clearMission();
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/mission/readback' && req.method === 'POST') {
    const result = requestMissionReadback('manual-api');
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/control' && req.method === 'POST') {
    const body = await readBody(req);
    const result = handleControl(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { code: 404, message: 'not found' });
  }

  return serveClient(req, res);
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  sendWs(ws, 'usv.telemetry', publicState());

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: unknown };
      if (message.type === 'manual.control') {
        const data = message.data as Partial<ManualControlInput>;
        sendManualControl({
          throttle: Number(data?.throttle ?? 0),
          steering: Number(data?.steering ?? 0)
        });
      }
      if (message.type === 'control.arm') sendArm(true);
      if (message.type === 'control.disarm') sendArm(false);
      if (message.type === 'control.emergencyStop') sendEmergencyStop();
      if (message.type === 'control.setMode') {
        const data = message.data as { mode?: string };
        sendSetMode(data?.mode);
      }
      // 航线控制
      if (message.type === 'mission.upload') {
        const data = message.data as { waypoints?: Waypoint[]; loopCount?: number };
        console.log(`WS mission upload requested: waypoints=${data.waypoints?.length ?? 0}, loop=${data.loopCount ?? 1}`);
        const result = uploadMission(data.waypoints || [], data.loopCount);
        sendWs(ws, 'mission.upload', result);
      }
      if (message.type === 'mission.pause') {
        const result = pauseMission();
        sendWs(ws, 'mission.pause', result);
      }
      if (message.type === 'mission.start') {
        const result = startMission();
        sendWs(ws, 'mission.start', result);
      }
      if (message.type === 'mission.resume') {
        const result = resumeMission();
        sendWs(ws, 'mission.resume', result);
      }
      if (message.type === 'mission.clear') {
        const result = clearMission();
        sendWs(ws, 'mission.clear', result);
      }
    } catch {
      sendWs(ws, 'error', { message: 'Invalid WebSocket message' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    sendManualControl({ throttle: 0, steering: 0 });
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP/WebSocket listening on http://127.0.0.1:${HTTP_PORT}`);
});

setInterval(() => {
  broadcastState();
  if (lastManualInputAt > 0 && Date.now() - lastManualInputAt > CONTROL_TIMEOUT_MS) {
    if (Date.now() - lastSentZeroAt > CONTROL_TIMEOUT_MS) {
      sendManualControl({ throttle: 0, steering: 0 }, false);
      lastSentZeroAt = Date.now();
    }
  }
}, 250);

function handleControl(body: unknown): { ok: boolean; message: string } {
  const payload = body as { action?: string; throttle?: number; steering?: number; mode?: string };
  if (payload.action === 'arm') return sendArm(true);
  if (payload.action === 'disarm') return sendArm(false);
  if (payload.action === 'emergencyStop') return sendEmergencyStop();
  if (payload.action === 'setMode') return sendSetMode(String(payload.mode ?? ''));
  if (payload.action === 'manual') {
    return sendManualControl({
      throttle: Number(payload.throttle ?? 0),
      steering: Number(payload.steering ?? 0)
    });
  }
  return { ok: false, message: 'unknown action' };
}

function sendSetMode(mode: unknown): { ok: boolean; message: string } {
  const modeKey = String(mode);
  if (modeKey === 'mission') {
    return { ok: false, message: 'mission mode is only allowed after mission upload/resume' };
  }
  if (!['manual', 'hold', 'rtl', 'posctl', 'stabilized'].includes(modeKey)) {
    return { ok: false, message: 'unknown mode' };
  }

  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  for (const frame of buildSetMode(state.systemId, state.componentId || 1, modeKey as never, state.autopilot)) {
    udp.send(frame, state.remote.port, state.remote.address);
  }
  broadcast('control.sent', { action: 'setMode', mode: modeKey });
  return { ok: true, message: `set mode ${modeKey} sent` };
}

function sendManualControl(input: ManualControlInput, markInput = true): { ok: boolean; message: string } {
  if (markInput) lastManualInputAt = Date.now();
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  const frames = [
    buildManualControl(state.systemId, input),
    buildRcChannelsOverride(state.systemId, state.componentId || 1, input)
  ];
  for (const frame of frames) udp.send(frame, state.remote.port, state.remote.address);
  broadcast('control.sent', { action: 'manual', input });
  return { ok: true, message: 'manual control sent' };
}

function sendArm(arm: boolean): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  for (const frame of [
    buildManualControl(state.systemId, { throttle: 0, steering: 0 }),
    buildRcChannelsOverride(state.systemId, state.componentId || 1, { throttle: 0, steering: 0 })
  ]) {
    udp.send(frame, state.remote.port, state.remote.address);
  }

  const frame = buildArmDisarm(state.systemId, state.componentId || 1, arm);
  udp.send(frame, state.remote.port, state.remote.address);

  for (const neutralFrame of [
    buildManualControl(state.systemId, { throttle: 0, steering: 0 }),
    buildRcChannelsOverride(state.systemId, state.componentId || 1, { throttle: 0, steering: 0 })
  ]) {
    udp.send(neutralFrame, state.remote.port, state.remote.address);
  }

  broadcast('control.sent', { action: arm ? 'arm' : 'disarm' });
  return { ok: true, message: arm ? 'arm sent' : 'disarm sent' };
}

function sendEmergencyStop(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  for (const frame of buildEmergencyStop(state.systemId, state.componentId || 1)) {
    udp.send(frame, state.remote.port, state.remote.address);
  }
  udp.send(
    buildRcChannelsOverride(state.systemId, state.componentId || 1, { throttle: 0, steering: 0 }),
    state.remote.port,
    state.remote.address
  );
  broadcast('control.sent', { action: 'emergencyStop' });
  return { ok: true, message: 'emergency stop sent' };
}

function publicState(): Omit<UsvState, 'remote'> & { remoteKnown: boolean; udpPort: number; mission: ReturnType<typeof store.getMissionState> } {
  const { remote, ...state } = store.getState();
  return {
    ...state,
    remoteKnown: remote !== null,
    udpPort: UDP_PORT,
    mission: store.getMissionState()
  };
}

function broadcastState(): void {
  broadcast('usv.telemetry', publicState());
}

function broadcast(type: string, data: unknown): void {
  for (const client of clients) sendWs(client, type, data);
}

function sendWs(ws: WebSocket, type: string, data: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, timestamp: new Date().toISOString(), data }));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(body));
}

async function serveClient(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const dist = resolve('client/dist');
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const filePath = url.pathname === '/' ? join(dist, 'index.html') : join(dist, url.pathname);

  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(content);
  } catch {
    try {
      const content = await readFile(join(dist, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch {
      sendJson(res, 200, { code: 200, data: publicState() });
    }
  }
}

function contentType(path: string): string {
  const ext = extname(path);
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}
