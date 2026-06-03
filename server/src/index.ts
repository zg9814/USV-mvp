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
  buildMissionClearAll,
  buildMissionSetCurrent,
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
  parseMissionAck,
  parseMissionCurrent,
  parseMissionItemReached
} from './mavlink.js';
import { UsvStore } from './state.js';
import type { ManualControlInput, UsvState, Waypoint } from './types.js';

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
let pendingWaypoints: Waypoint[] = [];

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
      case 40:
      case 51: { // MISSION_REQUEST / MISSION_REQUEST_INT - 飞控请求航点
        const request = parseMissionRequest(frame.payload);
        if (request && missionUploadInProgress) {
          handleMissionRequest(frame.systemId, frame.componentId, request.sequence);
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
          handleMissionAck(ack.type, ack.result);
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
  if (sequence < pendingWaypoints.length) {
    const wp = pendingWaypoints[sequence];
    const frame = buildMissionItemInt(targetSystem, targetComponent, sequence, wp.lat, wp.lng);
    udp.send(frame, store.getState().remote!.port, store.getState().remote!.address);
    console.log(`Sent waypoint ${sequence}: ${wp.lat}, ${wp.lng}`);
  }
}

function handleMissionAck(type: number, result: number): void {
  if (!missionUploadInProgress) return;

  if (type === 0 && result === 0) { // MAV_MISSION_ACCEPTED
    missionUploadInProgress = false;
    store.setMissionWaypoints(pendingWaypoints);
    store.setMissionStatus('active');
    const state = store.getState();
    if (state.remote) {
      udp.send(buildMissionSetCurrent(state.systemId, state.componentId || 1, 0), state.remote.port, state.remote.address);
      for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'mission', state.autopilot)) {
        udp.send(frame, state.remote.port, state.remote.address);
      }
    }
    pendingWaypoints = [];
    broadcast('mission.uploaded', { success: true });
    console.log('Mission uploaded successfully');
  } else {
    missionUploadInProgress = false;
    broadcast('mission.uploaded', { success: false, result });
    console.log(`Mission upload failed: type=${type} result=${result}`);
  }
}

function uploadMission(waypoints: Waypoint[]): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };
  if (waypoints.length === 0) return { ok: false, message: 'No waypoints' };

  const remote = state.remote;
  missionUploadInProgress = true;
  pendingWaypoints = waypoints;
  store.setMissionStatus('uploading');

  const countFrame = buildMissionCount(state.systemId, state.componentId || 1, waypoints.length);
  udp.send(countFrame, remote.port, remote.address);
  console.log(`Uploading mission with ${waypoints.length} waypoints`);

  return { ok: true, message: 'Mission upload started' };
}

function pauseMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  // 切换到 HOLD 模式暂停任务
  for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'hold', state.autopilot)) {
    udp.send(frame, state.remote.port, state.remote.address);
  }
  store.setMissionStatus('paused');
  broadcast('mission.paused', {});
  return { ok: true, message: 'Mission paused' };
}

function resumeMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  // 切换回 AUTO 模式继续任务
  for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'mission', state.autopilot)) {
    udp.send(frame, state.remote.port, state.remote.address);
  }
  store.setMissionStatus('active');
  broadcast('mission.resumed', {});
  return { ok: true, message: 'Mission resumed' };
}

function clearMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  const frame = buildMissionClearAll(state.systemId, state.componentId || 1);
  udp.send(frame, state.remote.port, state.remote.address);
  store.clearMission();
  broadcast('mission.cleared', {});
  return { ok: true, message: 'Mission cleared' };
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
    const body = await readBody(req) as { waypoints?: Waypoint[] };
    const result = uploadMission(body.waypoints || []);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/mission/pause' && req.method === 'POST') {
    const result = pauseMission();
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
        const data = message.data as { waypoints?: Waypoint[] };
        const result = uploadMission(data.waypoints || []);
        sendWs(ws, 'mission.upload', result);
      }
      if (message.type === 'mission.pause') {
        const result = pauseMission();
        sendWs(ws, 'mission.pause', result);
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
  if (!['manual', 'hold', 'mission', 'rtl', 'posctl', 'stabilized'].includes(modeKey)) {
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
