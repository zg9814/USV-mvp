import dgram from 'node:dgram';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildArmDisarm,
  buildCommandLongGeneric,
  buildEmergencyStop,
  buildManualControl,
  buildRcChannelsOverride,
  buildRebootAutopilot,
  buildSetHome,
  buildSetRelay,
  buildSetMode,
  buildMissionCount,
  buildMissionCommandInt,
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
  parseGps2Raw,
  parseGpsInjectData,
  parseGpsRawInt,
  parseGpsRtk,
  parseGpsStatus,
  parseHeartbeat,
  parseRtcmData,
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
import type { MavlinkFrame, ParsedCorrectionData, ParsedGps2Raw, ParsedGpsRtk, ParsedMissionItem } from './mavlink.js';
import { EventLogStore } from './eventLog.js';
import { CaptureStore, type CapturePointStatus, type CapturePlanInput } from './captureStore.js';
import { UsvStore } from './state.js';
import type { ManualControlInput, UsvState, Waypoint, MissionItem } from './types.js';

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 4000);
const UDP_PORT = Number(process.env.UDP_PORT ?? 14550);
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MS ?? 5000);
const CONTROL_TIMEOUT_MS = Number(process.env.CONTROL_TIMEOUT_MS ?? 500);
const REBOOT_DISARM_WAIT_MS = Number(process.env.REBOOT_DISARM_WAIT_MS ?? 3000);
const REBOOT_DISARM_POLL_MS = Number(process.env.REBOOT_DISARM_POLL_MS ?? 100);
const COMM_LOG_INTERVAL_MS = Number(process.env.COMM_LOG_INTERVAL_MS ?? 1000);
const COMM_TELEMETRY_LOG_INTERVAL_MS = Number(process.env.COMM_TELEMETRY_LOG_INTERVAL_MS ?? 10000);
const COMM_LOW_VOLTAGE = Number(process.env.COMM_LOW_VOLTAGE ?? 20);
const COMM_VOLTAGE_DROP = Number(process.env.COMM_VOLTAGE_DROP ?? 2);
const RETURN_HOME_LOW_VOLTAGE = Number(process.env.RETURN_HOME_LOW_VOLTAGE ?? 21.6);
const RETURN_HOME_LOW_VOLTAGE_SAMPLES = Number(process.env.RETURN_HOME_LOW_VOLTAGE_SAMPLES ?? 5);
const RETURN_HOME_RESET_VOLTAGE = Number(process.env.RETURN_HOME_RESET_VOLTAGE ?? 22);
const RETURN_HOME_ARRIVAL_RADIUS_M = Number(process.env.RETURN_HOME_ARRIVAL_RADIUS_M ?? 5);
const WAYPOINT_WAIT_MIN_SECONDS = 0;
const WAYPOINT_WAIT_MAX_SECONDS = 600;
const CAPTURE_DEFAULT_WAIT_SECONDS = Number(process.env.CAPTURE_DEFAULT_WAIT_SECONDS ?? 60);
const CAPTURE_DEFAULT_PHOTO_COUNT = Number(process.env.CAPTURE_DEFAULT_PHOTO_COUNT ?? 10);
const CAPTURE_DEFAULT_STEP_DEG = Number(process.env.CAPTURE_DEFAULT_STEP_DEG ?? 36);
const CAPTURE_AUX_RELAY = Number(process.env.CAPTURE_AUX_RELAY ?? 0);
const CAPTURE_AUX_PULSE_SECONDS = Number(process.env.CAPTURE_AUX_PULSE_SECONDS ?? 1);
const CAPTURE_UPLOAD_CHECK_DELAY_SECONDS = Number(process.env.CAPTURE_UPLOAD_CHECK_DELAY_SECONDS ?? 180);
const CAPTURE_REUPLOAD_MAX_ATTEMPTS = Number(process.env.CAPTURE_REUPLOAD_MAX_ATTEMPTS ?? 3);
const CAMERA_TRIGGER_COOLDOWN_MS = Number(process.env.CAMERA_TRIGGER_COOLDOWN_MS ?? 5000);
const LOG_RAW_MAVLINK = process.env.LOG_RAW_MAVLINK === '1';
const EVENT_DB_PATH = process.env.EVENT_DB_PATH ?? 'data/usv-events.sqlite';
const EVENT_LOG_RETENTION_DAYS = Number(process.env.EVENT_LOG_RETENTION_DAYS ?? 30);
const OUTFALL_MODEL_PATH = process.env.OUTFALL_MODEL_PATH ?? 'models/outfall_yolov8s.pt';
const OUTFALL_CONFIDENCE = Number(process.env.OUTFALL_CONFIDENCE ?? 0.25);
let aiDetectionEnabled = process.env.OUTFALL_DETECTION_ENABLED !== 'false';
const OUTFALL_DETECTION_PYTHON = process.env.OUTFALL_DETECTION_PYTHON ?? 'python3';
const OUTFALL_DETECTION_SCRIPT = process.env.OUTFALL_DETECTION_SCRIPT ?? 'server/scripts/outfall_detect.py';

const store = new UsvStore(OFFLINE_AFTER_MS);
const eventLog = new EventLogStore(EVENT_DB_PATH, EVENT_LOG_RETENTION_DAYS);
const captureStore = new CaptureStore(EVENT_DB_PATH);
const udp = dgram.createSocket('udp4');
const clients = new Set<WebSocket>();

type PiClientState = {
  connectedAt: string;
  registeredAt: string | null;
  deviceId: string | null;
  piId: string | null;
  firmwareVersion: string | null;
  cameraCount: number | null;
  lastHeartbeatAt: string | null;
  lastMessageType: string | null;
  lastMessageAt: string | null;
  lastCaptureStatus: unknown;
  lastReuploadResult: unknown;
};

const piClients = new Map<WebSocket, PiClientState>();
let lastPiOutbound: { type: string; sentAt: string; data: unknown } | null = null;

let lastManualInputAt = 0;
let lastSentZeroAt = 0;
let missionUploadInProgress = false;
let pendingMissionItems: MissionItem[] = [];
let lastUploadMissionItems: MissionItem[] = [];
let pendingCapturePlan: CapturePlanInput[] = [];
let pendingCaptureMissionId: string | null = null;
let currentCaptureMissionId: string | null = null;
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
let lastCommLogAt = 0;
let lastRemoteKey: string | null = null;
let lastVoltageSample: { voltage: number; at: number } | null = null;
let lastLowVoltageLogAt = 0;
let lastVoltageDropLogAt = 0;
let lastBatteryCurrent: number | null = null;
let lastManualControlLogAt = 0;
let pendingRebootAfterDisarmTimer: NodeJS.Timeout | null = null;
let lastTelemetrySampleAt = 0;
let lastOnlineLogged: boolean | null = null;
let lastCameraTriggerAt = 0;
let detectionWorkerRunning = false;
let lastGpsLogSnapshot: GpsLogSnapshot | null = null;
let lastGpsQualityLogAt = 0;
let lastGpsDegradedDiagnosticAt = 0;
let lastGps2LogSnapshot: GpsLogSnapshot | null = null;
let lastRtkByMessage = new Map<number, RtkDiagnosticSnapshot>();
let lastCorrectionByMessage = new Map<number, CorrectionDiagnosticSnapshot>();
let lastCorrectionLogAt = 0;
let lastRtkStatusLogAt = 0;
let homeState: HomeState = {
  point: null,
  syncStatus: 'unset',
  lastSyncAt: null,
  lastAckAt: null,
  lastResult: null,
  lastError: null
};
let returnHomeState: ReturnHomeState = {
  active: false,
  reason: null,
  startedAt: null,
  completedAt: null,
  lastDistanceMeters: null
};
let lowVoltageReturnCount = 0;
let lowVoltageReturnTriggered = false;
let lastLowVoltageReturnSampleAt = 0;

type HomePoint = {
  lat: number;
  lng: number;
  altitude: number | null;
};

type HomeState = {
  point: HomePoint | null;
  syncStatus: 'unset' | 'pending' | 'accepted' | 'rejected' | 'failed';
  lastSyncAt: string | null;
  lastAckAt: string | null;
  lastResult: string | null;
  lastError: string | null;
};

type ReturnHomeState = {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastDistanceMeters: number | null;
};

type GpsLogSnapshot = {
  fixType: number | null;
  fixLabel: string;
  satellites: number | null;
  hdop: number | null;
  vdop: number | null;
  horizontalAccuracy: number | null;
  lat: number | null;
  lng: number | null;
};

type RtkDiagnosticSnapshot = ParsedGpsRtk & {
  source: string;
  messageId: number;
  remote: string;
  seenAt: string;
};

type CorrectionDiagnosticSnapshot = ParsedCorrectionData & {
  source: string;
  messageId: number;
  remote: string;
  seenAt: string;
};

type MissionBuildResult = {
  missionId: string | null;
  items: MissionItem[];
  capturePlan: CapturePlanInput[];
};

eventLog.cleanup();
eventLog.logEvent({
  level: 'info',
  category: 'service',
  type: 'startup',
  message: 'USV service started',
  details: { httpPort: HTTP_PORT, udpPort: UDP_PORT, dbPath: EVENT_DB_PATH, retentionDays: EVENT_LOG_RETENTION_DAYS }
});
setInterval(() => eventLog.cleanup(), 60 * 60 * 1000);

udp.on('message', (packet, remote) => {
  if (LOG_RAW_MAVLINK || missionUploadInProgress || missionReadbackInProgress) {
    console.log(`RX UDP raw bytes=${packet.length} from=${remote.address}:${remote.port} hex=${packet.toString('hex')}`);
  }
  const frames = decodeFrames(packet);
  const remoteKey = `${remote.address}:${remote.port}`;
  const messageIds: number[] = [];
  let packetVoltage: number | null = null;
  let packetCurrent: number | null = null;
  let packetBattery: number | null = null;
  let packetHadTelemetry = false;

  if (frames.length > 0 && remoteKey !== lastRemoteKey) {
    console.log(`COMM LINK remote=${remoteKey} previous=${lastRemoteKey ?? 'none'} packets=${frames.length}`);
    logEventFromState('info', 'link', 'remote_changed', `Remote endpoint changed to ${remoteKey}`, {
      previous: lastRemoteKey,
      current: remoteKey,
      packets: frames.length
    });
    lastRemoteKey = remoteKey;
  }

  for (const frame of frames) {
    messageIds.push(frame.messageId);
    const state = store.markSeen(frame.systemId, frame.componentId, {
      address: remote.address,
      port: remote.port
    });

    switch (frame.messageId) {
      case 0: {
        const heartbeat = parseHeartbeat(frame.payload);
        if (heartbeat) {
          store.patch(heartbeat);
          packetHadTelemetry = true;
        }
        break;
      }
      case 1: {
        const sys = parseSysStatus(frame.payload);
        if (sys) {
          store.patch(sys);
          packetVoltage = sys.voltage;
          packetBattery = sys.batteryPercent;
          packetCurrent = readSysStatusCurrent(frame.payload);
          lastBatteryCurrent = packetCurrent;
          observeVoltage('SYS_STATUS', packetVoltage, packetCurrent, packetBattery, remoteKey);
          packetHadTelemetry = true;
        }
        break;
      }
      case 24: {
        const gps = parseGpsRawInt(frame.payload);
        if (gps) {
          store.patch(gps);
          observeGpsState('GPS_RAW_INT', remoteKey);
          packetHadTelemetry = true;
        }
        break;
      }
      case 25: {
        const gpsStatus = parseGpsStatus(frame.payload);
        if (gpsStatus) {
          store.patch(gpsStatus);
          observeGpsState('GPS_STATUS', remoteKey);
          packetHadTelemetry = true;
        }
        break;
      }
      case 33: {
        const position = parseGlobalPositionInt(frame.payload);
        if (position) {
          store.patch(position);
          packetHadTelemetry = true;
        }
        break;
      }
      case 74: {
        const hud = parseVfrHud(frame.payload);
        if (hud) {
          store.patch(hud);
          packetHadTelemetry = true;
        }
        break;
      }
      case 123: {
        const correction = parseGpsInjectData(frame.payload);
        if (correction) {
          observeCorrectionData(frame, remoteKey, 'GPS_INJECT_DATA', correction);
        }
        break;
      }
      case 124: {
        const gps2 = parseGps2Raw(frame.payload);
        if (gps2) {
          observeGps2State('GPS2_RAW', remoteKey, gps2);
          packetHadTelemetry = true;
        }
        break;
      }
      case 127: {
        const rtk = parseGpsRtk(frame.payload);
        if (rtk) {
          observeRtkState(frame, remoteKey, 'GPS_RTK', rtk);
        }
        break;
      }
      case 128: {
        const rtk = parseGpsRtk(frame.payload);
        if (rtk) {
          observeRtkState(frame, remoteKey, 'GPS2_RTK', rtk);
        }
        break;
      }
      case 77: {
        const ack = parseCommandAck(frame.payload);
        if (ack) {
          console.log(`COMM RX COMMAND_ACK remote=${remoteKey} sys=${frame.systemId} comp=${frame.componentId} command=${ack.command} result=${ack.resultName}`);
          logEventFromFrame(frame, remoteKey, ack.result === 0 ? 'info' : 'warn', 'ack', 'command_ack', `COMMAND_ACK command=${ack.command} result=${ack.resultName}`, {
            command: ack.command,
            result: ack.result,
            resultName: ack.resultName
          }, ack.command, ack.resultName, frame.raw.toString('hex'));
          handleCommandAck(ack.command, ack.resultName);
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
        if (battery) {
          store.patch(battery);
          if (battery.voltage !== null) {
            packetVoltage = battery.voltage;
            packetBattery = battery.batteryPercent;
            observeVoltage('BATTERY_STATUS', packetVoltage, null, packetBattery, remoteKey);
          }
          packetHadTelemetry = true;
        }
        break;
      }
      case 233: {
        const correction = parseRtcmData(frame.payload);
        if (correction) {
          observeCorrectionData(frame, remoteKey, 'RTCM_DATA', correction);
        }
        break;
      }
      case 253: {
        const status = parseStatusText(frame.payload);
        if (status?.text) {
          console.log(`COMM RX STATUSTEXT remote=${remoteKey} severity=${status.severity} text=${JSON.stringify(status.text)}`);
          logEventFromFrame(frame, remoteKey, status.severity <= 3 ? 'warn' : 'info', 'statustext', 'statustext', status.text, {
            severity: status.severity
          }, null, String(status.severity), frame.raw.toString('hex'));
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
          handleMissionReached(reached.seq);
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

  if (frames.length > 0 && packetHadTelemetry && Date.now() - lastCommLogAt >= COMM_TELEMETRY_LOG_INTERVAL_MS) {
    logCommSummary(remoteKey, messageIds, packetVoltage, packetCurrent, packetBattery);
  }

  if (frames.length > 0) broadcastState();
});

udp.on('listening', () => {
  const address = udp.address();
  console.log(`UDP MAVLink2 listening on ${address.address}:${address.port}`);
});

udp.bind(UDP_PORT, '0.0.0.0');

function readSysStatusCurrent(payload: Buffer): number | null {
  if (payload.length < 18) return null;
  const currentRaw = payload.readInt16LE(16);
  return currentRaw === -1 ? null : currentRaw / 100;
}

function observeVoltage(source: string, voltage: number | null, current: number | null, battery: number | null, remote: string): void {
  if (voltage === null || !Number.isFinite(voltage)) return;
  const now = Date.now();
  observeReturnHomeVoltage(source, voltage, current, battery, remote);
  if (voltage <= COMM_LOW_VOLTAGE) {
    console.warn(`COMM ALERT low_voltage source=${source} remote=${remote} voltage=${voltage.toFixed(3)} current=${formatNumber(current, 2)} battery=${formatPercent(battery)}`);
    if (now - lastLowVoltageLogAt >= 60_000) {
      lastLowVoltageLogAt = now;
      logEventFromState('warn', 'power', 'low_voltage', `Low voltage ${voltage.toFixed(3)} V`, {
        source,
        voltage,
        current,
        battery,
        threshold: COMM_LOW_VOLTAGE,
        remote
      });
    }
  }
  if (lastVoltageSample && now - lastVoltageSample.at <= 10_000) {
    const drop = lastVoltageSample.voltage - voltage;
    if (drop >= COMM_VOLTAGE_DROP) {
      console.warn(`COMM ALERT voltage_drop source=${source} remote=${remote} from=${lastVoltageSample.voltage.toFixed(3)} to=${voltage.toFixed(3)} drop=${drop.toFixed(3)} current=${formatNumber(current, 2)} battery=${formatPercent(battery)}`);
      if (now - lastVoltageDropLogAt >= 60_000) {
        lastVoltageDropLogAt = now;
        logEventFromState('warn', 'power', 'voltage_drop', `Fast voltage drop ${drop.toFixed(3)} V`, {
          source,
          from: lastVoltageSample.voltage,
          to: voltage,
          drop,
          current,
          battery,
          threshold: COMM_VOLTAGE_DROP,
          remote
        });
      }
    }
  }
  lastVoltageSample = { voltage, at: now };
}

function observeGpsState(source: string, remote: string): void {
  const state = store.getState();
  const snapshot = getGpsLogSnapshot(state);
  const previous = lastGpsLogSnapshot;

  if (!previous) {
    lastGpsLogSnapshot = snapshot;
    logEventFromState('info', 'gps', 'status_initial', `GPS ${snapshot.fixLabel}`, {
      source,
      remote,
      currentGps: snapshot
    });
    return;
  }

  if (snapshot.fixType !== previous.fixType || snapshot.fixLabel !== previous.fixLabel) {
    const degraded = isRtkFix(previous.fixLabel) && !isRtkFix(snapshot.fixLabel);
    const restored = !isRtkFix(previous.fixLabel) && isRtkFix(snapshot.fixLabel);
    const level = degraded ? 'warn' : 'info';
    const type = degraded ? 'rtk_lost' : restored ? 'rtk_restored' : 'fix_changed';
    logEventFromState(level, 'gps', type, `GPS fix ${previous.fixLabel} -> ${snapshot.fixLabel}`, {
      source,
      remote,
      previousGps: previous,
      currentGps: snapshot,
      diagnostics: getGpsDiagnostics()
    });
    lastGpsLogSnapshot = snapshot;
    return;
  }

  const now = Date.now();
  if (!isRtkFix(snapshot.fixLabel) && now - lastGpsDegradedDiagnosticAt >= 60_000) {
    lastGpsDegradedDiagnosticAt = now;
    logEventFromState('warn', 'gps', 'rtk_degraded_status', `GPS remains ${snapshot.fixLabel}; RTK diagnostics snapshot`, {
      source,
      remote,
      currentGps: snapshot,
      diagnostics: getGpsDiagnostics()
    });
  }

  if (now - lastGpsQualityLogAt >= 60_000 && gpsQualityChanged(previous, snapshot)) {
    lastGpsQualityLogAt = now;
    logEventFromState('info', 'gps', 'quality_changed', `GPS quality ${snapshot.fixLabel}`, {
      source,
      remote,
      previousGps: previous,
      currentGps: snapshot
    });
  }
  lastGpsLogSnapshot = snapshot;
}

function observeGps2State(source: string, remote: string, gps2: ParsedGps2Raw): void {
  const snapshot: GpsLogSnapshot = {
    fixType: gps2.gpsFixType,
    fixLabel: gps2.gpsFixLabel,
    satellites: gps2.gpsSatellites,
    hdop: gps2.gpsHdop,
    vdop: gps2.gpsVdop,
    horizontalAccuracy: gps2.gpsHorizontalAccuracy,
    lat: gps2.gps2Lat,
    lng: gps2.gps2Lng
  };
  const previous = lastGps2LogSnapshot;

  if (!previous) {
    lastGps2LogSnapshot = snapshot;
    logEventFromState('info', 'gps', 'gps2_status_initial', `GPS2 ${snapshot.fixLabel}`, {
      source,
      remote,
      currentGps2: snapshot,
      dgpsAgeMs: gps2.gps2DgpsAgeMs,
      dgpsChannels: gps2.gps2DgpsChannels
    });
    return;
  }

  if (snapshot.fixType !== previous.fixType || snapshot.fixLabel !== previous.fixLabel) {
    const degraded = isRtkFix(previous.fixLabel) && !isRtkFix(snapshot.fixLabel);
    const restored = !isRtkFix(previous.fixLabel) && isRtkFix(snapshot.fixLabel);
    logEventFromState(degraded ? 'warn' : 'info', 'gps', degraded ? 'gps2_rtk_lost' : restored ? 'gps2_rtk_restored' : 'gps2_fix_changed', `GPS2 fix ${previous.fixLabel} -> ${snapshot.fixLabel}`, {
      source,
      remote,
      previousGps2: previous,
      currentGps2: snapshot,
      dgpsAgeMs: gps2.gps2DgpsAgeMs,
      dgpsChannels: gps2.gps2DgpsChannels,
      diagnostics: getGpsDiagnostics()
    });
  }

  lastGps2LogSnapshot = snapshot;
}

function observeRtkState(frame: MavlinkFrame, remote: string, source: string, rtk: ParsedGpsRtk): void {
  const snapshot: RtkDiagnosticSnapshot = {
    ...rtk,
    source,
    messageId: frame.messageId,
    remote,
    seenAt: new Date().toISOString()
  };
  const previous = lastRtkByMessage.get(frame.messageId);
  lastRtkByMessage.set(frame.messageId, snapshot);

  const changed = !previous
    || previous.health !== snapshot.health
    || previous.satellites !== snapshot.satellites
    || Math.abs(previous.accuracyMm - snapshot.accuracyMm) >= 50
    || previous.rateHz !== snapshot.rateHz
    || previous.baselineLengthMm !== snapshot.baselineLengthMm;
  const now = Date.now();
  if (!changed && now - lastRtkStatusLogAt < 60_000) return;

  lastRtkStatusLogAt = now;
  logEventFromFrame(frame, remote, snapshot.health === 0 ? 'warn' : 'info', 'gps', 'rtk_status', `${source} health=${snapshot.health} sats=${snapshot.satellites} accuracy=${snapshot.accuracyMm}mm`, {
    source,
    previousRtk: previous ?? null,
    currentRtk: snapshot
  });
}

function observeCorrectionData(frame: MavlinkFrame, remote: string, source: string, correction: ParsedCorrectionData): void {
  const snapshot: CorrectionDiagnosticSnapshot = {
    ...correction,
    source,
    messageId: frame.messageId,
    remote,
    seenAt: new Date().toISOString()
  };
  lastCorrectionByMessage.set(frame.messageId, snapshot);

  const now = Date.now();
  if (now - lastCorrectionLogAt < 60_000) return;
  lastCorrectionLogAt = now;
  logEventFromFrame(frame, remote, 'info', 'gps', 'correction_seen', `${source} len=${snapshot.length}`, {
    source,
    correction: snapshot
  });
}

function getGpsLogSnapshot(state: UsvState): GpsLogSnapshot {
  return {
    fixType: state.gpsFixType,
    fixLabel: state.gpsFixLabel,
    satellites: state.gpsSatellites,
    hdop: state.gpsHdop,
    vdop: state.gpsVdop,
    horizontalAccuracy: state.gpsHorizontalAccuracy,
    lat: state.lat,
    lng: state.lng
  };
}

function getGpsDiagnostics(): Record<string, unknown> {
  const now = Date.now();
  const latestCorrection = latestBySeenAt([...lastCorrectionByMessage.values()]);
  const latestRtk = latestBySeenAt([...lastRtkByMessage.values()]);
  return {
    lastCorrection: latestCorrection,
    lastCorrectionAgeSeconds: latestCorrection ? Math.max(0, Math.round((now - Date.parse(latestCorrection.seenAt)) / 1000)) : null,
    rtk: [...lastRtkByMessage.values()],
    latestRtk,
    latestRtkAgeSeconds: latestRtk ? Math.max(0, Math.round((now - Date.parse(latestRtk.seenAt)) / 1000)) : null,
    gps2: lastGps2LogSnapshot,
    coverage: {
      gps2RawSeen: lastGps2LogSnapshot !== null,
      rtkStatusSeen: lastRtkByMessage.size > 0,
      correctionSeen: lastCorrectionByMessage.size > 0
    },
    notes: [
      latestCorrection ? null : 'No RTCM_DATA/GPS_INJECT_DATA observed on this telemetry link',
      latestRtk ? null : 'No GPS_RTK/GPS2_RTK observed on this telemetry link',
      lastGps2LogSnapshot ? null : 'No GPS2_RAW observed on this telemetry link'
    ].filter(Boolean)
  };
}

function latestBySeenAt<T extends { seenAt: string }>(items: T[]): T | null {
  return items.reduce<T | null>((latest, item) => {
    if (!latest) return item;
    return Date.parse(item.seenAt) > Date.parse(latest.seenAt) ? item : latest;
  }, null);
}

function isRtkFix(label: string | null | undefined): boolean {
  return label === 'RTK_FIXED' || label === 'RTK_FLOAT';
}

function gpsQualityChanged(previous: GpsLogSnapshot, current: GpsLogSnapshot): boolean {
  if (typeof previous.satellites === 'number' && typeof current.satellites === 'number') {
    if (Math.abs(current.satellites - previous.satellites) >= 5) return true;
  }
  if (typeof previous.hdop === 'number' && typeof current.hdop === 'number') {
    if (Math.abs(current.hdop - previous.hdop) >= 0.5) return true;
  }
  if (typeof previous.horizontalAccuracy === 'number' && typeof current.horizontalAccuracy === 'number') {
    if (Math.abs(current.horizontalAccuracy - previous.horizontalAccuracy) >= 1) return true;
  }
  return false;
}

function logCommSummary(
  remote: string,
  messageIds: number[],
  packetVoltage: number | null,
  packetCurrent: number | null,
  packetBattery: number | null
): void {
  lastCommLogAt = Date.now();
  const state = store.getState();
  const voltage = packetVoltage ?? state.voltage;
  const current = packetCurrent ?? lastBatteryCurrent;
  const battery = packetBattery ?? state.batteryPercent;
  console.log([
    'COMM RX telemetry',
    `remote=${remote}`,
    `msgs=${summarizeMessages(messageIds)}`,
    `sys=${state.systemId}/${state.componentId}`,
    `mode=${state.mode}`,
    `armed=${state.armed}`,
    `voltage=${formatNumber(voltage, 3)}V`,
    `current=${formatNumber(current, 2)}A`,
    `battery=${formatPercent(battery)}`,
    `gps=${state.gpsFixLabel}`,
    `sats=${formatValue(state.gpsSatellites)}`,
    `hdop=${formatNumber(state.gpsHdop, 2)}`,
    `lat=${formatNumber(state.lat, 7)}`,
    `lng=${formatNumber(state.lng, 7)}`,
    `speed=${formatNumber(state.speed, 2)}`,
    `heading=${formatNumber(state.heading, 1)}`
  ].join(' '));
}

function summarizeMessages(messageIds: number[]): string {
  const counts = new Map<number, number>();
  for (const id of messageIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].map(([id, count]) => `${messageName(id)}:${count}`).join(',');
}

function messageName(id: number): string {
  const names: Record<number, string> = {
    0: 'HEARTBEAT',
    1: 'SYS_STATUS',
    24: 'GPS_RAW_INT',
    25: 'GPS_STATUS',
    30: 'ATTITUDE',
    33: 'GLOBAL_POSITION_INT',
    40: 'MISSION_REQUEST',
    42: 'MISSION_CURRENT',
    44: 'MISSION_COUNT',
    46: 'MISSION_ITEM_REACHED',
    47: 'MISSION_ACK',
    73: 'MISSION_ITEM_INT',
    74: 'VFR_HUD',
    77: 'COMMAND_ACK',
    123: 'GPS_INJECT_DATA',
    124: 'GPS2_RAW',
    127: 'GPS_RTK',
    128: 'GPS2_RTK',
    147: 'BATTERY_STATUS',
    233: 'RTCM_DATA',
    253: 'STATUSTEXT'
  };
  return names[id] ?? `MSG_${id}`;
}

function formatNumber(value: number | null | undefined, digits: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}%` : '--';
}

function formatValue(value: number | string | boolean | null | undefined): string {
  return value === null || value === undefined ? '--' : String(value);
}

function logControlTx(action: string, details: Record<string, unknown> = {}, force = false, rawHex: string | null = null, command: number | null = null): void {
  if (!force && action === 'manual' && Date.now() - lastManualControlLogAt < COMM_LOG_INTERVAL_MS) return;
  if (action === 'manual') lastManualControlLogAt = Date.now();
  const state = store.getState();
  const detailText = Object.entries(details).map(([key, value]) => `${key}=${value}`).join(' ');
  console.log([
    'COMM TX control',
    `action=${action}`,
    detailText,
    `target=${state.systemId}/${state.componentId || 1}`,
    `remote=${state.remote ? `${state.remote.address}:${state.remote.port}` : 'unknown'}`,
    `mode=${state.mode}`,
    `armed=${state.armed}`,
    `voltage=${formatNumber(state.voltage, 3)}V`
  ].filter(Boolean).join(' '));
  logEventFromState('info', 'control', 'control_tx', `Control TX ${action}`, {
    action,
    ...details
  }, command, null, rawHex);
}

function logEventFromState(
  level: 'debug' | 'info' | 'warn' | 'error',
  category: string,
  type: string,
  message: string,
  details: Record<string, unknown> | null = null,
  command: number | null = null,
  result: string | null = null,
  rawHex: string | null = null
): void {
  const state = store.getState();
  eventLog.logEvent({
    level,
    category,
    type,
    deviceId: state.deviceId,
    systemId: state.systemId,
    componentId: state.componentId,
    remoteAddress: state.remote?.address ?? null,
    remotePort: state.remote?.port ?? null,
    mode: state.mode,
    armed: state.armed,
    command,
    result,
    message,
    details: withStateSnapshot(details, state),
    rawHex
  });
}

function logEventFromFrame(
  frame: MavlinkFrame,
  remote: string | null,
  level: 'debug' | 'info' | 'warn' | 'error',
  category: string,
  type: string,
  message: string,
  details: Record<string, unknown> | null = null,
  command: number | null = null,
  result: string | null = null,
  rawHex: string | null = null
): void {
  const state = store.getState();
  const remoteParts = remote ? splitRemote(remote) : null;
  eventLog.logEvent({
    level,
    category,
    type,
    deviceId: state.deviceId || `USV-SYS-${frame.systemId}`,
    systemId: frame.systemId,
    componentId: frame.componentId,
    remoteAddress: remoteParts?.address ?? state.remote?.address ?? null,
    remotePort: remoteParts?.port ?? state.remote?.port ?? null,
    mode: state.mode,
    armed: state.armed,
    command,
    result,
    message,
    details: withStateSnapshot(details, state),
    rawHex
  });
}

function withStateSnapshot(details: Record<string, unknown> | null, state: UsvState): Record<string, unknown> {
  return {
    ...(details ?? {}),
    voltage: state.voltage,
    current: lastBatteryCurrent,
    batteryPercent: state.batteryPercent,
    gpsFixType: state.gpsFixType,
    gpsFixLabel: state.gpsFixLabel,
    gpsSatellites: state.gpsSatellites,
    gpsHdop: state.gpsHdop,
    lat: state.lat,
    lng: state.lng,
    speed: state.speed,
    heading: state.heading
  };
}

function splitRemote(remote: string): { address: string; port: number | null } {
  const index = remote.lastIndexOf(':');
  if (index < 0) return { address: remote, port: null };
  const port = Number(remote.slice(index + 1));
  return {
    address: remote.slice(0, index),
    port: Number.isFinite(port) ? port : null
  };
}

function handleCommandAck(command: number, resultName: string): void {
  if (command !== 179) return;
  homeState = {
    ...homeState,
    syncStatus: resultName === 'ACCEPTED' ? 'accepted' : 'rejected',
    lastAckAt: new Date().toISOString(),
    lastResult: resultName,
    lastError: resultName === 'ACCEPTED' ? null : `SET_HOME rejected: ${resultName}`
  };
  broadcast('home.syncAck', publicHomeState());
  logEventFromState(resultName === 'ACCEPTED' ? 'info' : 'warn', 'home', 'set_home_ack', `SET_HOME ${resultName}`, {
    result: resultName,
    home: homeState.point
  }, 179, resultName);
}

function setHomeFromInput(input: unknown): { ok: boolean; message: string; data?: HomeState } {
  const payload = input as { lat?: number; lng?: number; altitude?: number | null };
  const lat = Number(payload?.lat);
  const lng = Number(payload?.lng);
  const altitudeValue = payload?.altitude === null || payload?.altitude === undefined ? null : Number(payload.altitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { ok: false, message: 'invalid home coordinates' };
  }
  if (altitudeValue !== null && !Number.isFinite(altitudeValue)) {
    return { ok: false, message: 'invalid home altitude' };
  }

  homeState = {
    point: { lat, lng, altitude: altitudeValue },
    syncStatus: 'pending',
    lastSyncAt: new Date().toISOString(),
    lastAckAt: null,
    lastResult: null,
    lastError: null
  };
  broadcast('home.updated', publicHomeState());
  logEventFromState('info', 'home', 'home_set', 'Home point set from client', { home: homeState.point });

  const syncResult = syncHomeToAutopilot();
  if (!syncResult.ok) {
    homeState = {
      ...homeState,
      syncStatus: 'failed',
      lastError: syncResult.message
    };
    broadcast('home.updated', publicHomeState());
    return { ok: false, message: syncResult.message, data: homeState };
  }

  return { ok: true, message: 'home set and sync requested', data: homeState };
}

function syncHomeToAutopilot(): { ok: boolean; message: string } {
  const state = store.getState();
  const home = homeState.point;
  if (!home) return { ok: false, message: 'home is not set' };
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  const frame = buildSetHome(state.systemId, state.componentId || 1, home.lat, home.lng, home.altitude ?? state.gpsAltitude ?? 0);
  logControlTx('setHome', { lat: home.lat, lng: home.lng, altitude: home.altitude ?? state.gpsAltitude ?? 0 }, true, frame.toString('hex'), 179);
  udp.send(frame, state.remote.port, state.remote.address);
  return { ok: true, message: 'set home sent' };
}

function startReturnHome(reason: string): { ok: boolean; message: string } {
  const state = store.getState();
  if (!homeState.point) return { ok: false, message: 'home is not set' };
  if (homeState.syncStatus !== 'accepted') return { ok: false, message: 'home has not been accepted by autopilot' };
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  const frames = buildSetMode(state.systemId, state.componentId || 1, 'rtl', state.autopilot);
  logControlTx('returnHome', { reason, lat: homeState.point.lat, lng: homeState.point.lng }, true, frames.at(-1)?.toString('hex') ?? null, 176);
  for (const frame of frames) udp.send(frame, state.remote.port, state.remote.address);
  returnHomeState = {
    active: true,
    reason,
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastDistanceMeters: distanceToHome(state)
  };
  store.setMissionStatus('active');
  broadcast('return.home', publicReturnHomeState());
  broadcast('control.sent', { action: 'returnHome', reason });
  logEventFromState(reason === 'low_voltage' ? 'warn' : 'info', 'return_home', 'started', `Return home started (${reason})`, {
    reason,
    home: homeState.point,
    distanceMeters: returnHomeState.lastDistanceMeters
  });
  return { ok: true, message: 'return home started' };
}

function observeReturnHomeArrival(): void {
  if (!returnHomeState.active || !homeState.point) return;
  const state = store.getState();
  const distance = distanceToHome(state);
  returnHomeState.lastDistanceMeters = distance;
  if (distance === null || distance > RETURN_HOME_ARRIVAL_RADIUS_M) return;

  for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'hold', state.autopilot)) {
    if (state.remote) udp.send(frame, state.remote.port, state.remote.address);
  }
  returnHomeState = {
    ...returnHomeState,
    active: false,
    completedAt: new Date().toISOString(),
    lastDistanceMeters: distance
  };
  store.setMissionStatus('completed');
  broadcast('return.home', publicReturnHomeState());
  broadcast('mission.completed', { reason: 'home-arrived', distanceMeters: distance });
  logEventFromState('info', 'return_home', 'arrived', 'Return home arrived; HOLD sent', {
    reason: returnHomeState.reason,
    distanceMeters: distance,
    radiusMeters: RETURN_HOME_ARRIVAL_RADIUS_M
  });
}

function observeReturnHomeVoltage(source: string, voltage: number, current: number | null, battery: number | null, remote: string): void {
  const now = Date.now();
  if (now - lastLowVoltageReturnSampleAt < 1000) return;
  lastLowVoltageReturnSampleAt = now;
  if (voltage >= RETURN_HOME_RESET_VOLTAGE) {
    lowVoltageReturnCount = 0;
    lowVoltageReturnTriggered = false;
    return;
  }
  if (voltage >= RETURN_HOME_LOW_VOLTAGE) return;
  lowVoltageReturnCount += 1;
  if (lowVoltageReturnTriggered || lowVoltageReturnCount < RETURN_HOME_LOW_VOLTAGE_SAMPLES) return;
  lowVoltageReturnTriggered = true;
  logEventFromState('warn', 'power', 'low_voltage_return_home', `Low voltage return home triggered at ${voltage.toFixed(3)} V`, {
    source,
    voltage,
    current,
    battery,
    remote,
    threshold: RETURN_HOME_LOW_VOLTAGE,
    samples: lowVoltageReturnCount
  });
  const result = startReturnHome('low_voltage');
  if (!result.ok) {
    logEventFromState('error', 'return_home', 'auto_return_failed', result.message, {
      source,
      voltage,
      home: homeState.point,
      homeSyncStatus: homeState.syncStatus
    });
  }
}

function distanceToHome(state: UsvState): number | null {
  if (!homeState.point || state.lat === null || state.lng === null) return null;
  return haversineMeters({ lat: state.lat, lng: state.lng }, homeState.point);
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const earthRadiusMeters = 6371008.8;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const value = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

// ==================== 航线处理函数 ====================

function handleMissionRequest(targetSystem: number, targetComponent: number, sequence: number): void {
  if (sequence < pendingMissionItems.length) {
    const item = pendingMissionItems[sequence];
    const waitSeconds = item.type === 'waypoint' ? sanitizeWaitSeconds(item.waitSeconds) : 0;
    const frame = item.type === 'doJump'
      ? buildMissionDoJumpInt(targetSystem, targetComponent, sequence, item.target, item.repeat)
      : item.type === 'aux'
        ? buildMissionCommandInt(targetSystem, targetComponent, sequence, 181, [item.relay, 1, item.pulseSeconds])
        : buildMissionItemInt(targetSystem, targetComponent, sequence, item.lat, item.lng, item.altitude ?? 0, 16, item.type === 'home' ? 0 : 6, waitSeconds);
    const label = item.type === 'doJump'
      ? `MISSION_DO_JUMP_INT seq=${sequence}`
      : item.type === 'aux'
        ? `MISSION_AUX_CAPTURE seq=${sequence} capturePoint=${item.capturePointIndex} relay=${item.relay}`
        : `MISSION_ITEM_INT seq=${sequence} hold=${waitSeconds}s`;
    sendMissionFrame(frame, label);
    console.log(item.type === 'doJump'
      ? `Sent DO_JUMP ${sequence}: target=${item.target} repeat=${item.repeat}`
      : item.type === 'aux'
        ? `Sent AUX capture ${sequence}: point=${item.capturePointIndex} relay=${item.relay} pulse=${item.pulseSeconds}s`
        : `Sent waypoint ${sequence} as MISSION_ITEM_INT: ${item.lat}, ${item.lng}, hold=${waitSeconds}s`);
  }
}

function sendMissionFrame(frame: Buffer, label: string): void {
  const remote = store.getState().remote;
  if (!remote) return;
  const messageId = frame.length >= 10 ? frame[7] | (frame[8] << 8) | (frame[9] << 16) : -1;
  const txSeq = frame.length >= 5 ? frame[4] : -1;
  console.log(`TX MAVLink ${label} msg=${messageId} txSeq=${txSeq} bytes=${frame.length} to=${remote.address}:${remote.port} hex=${frame.toString('hex')}`);
  logEventFromState('info', 'mission', 'mission_tx', label, {
    messageId,
    txSeq,
    bytes: frame.length
  }, null, null, frame.toString('hex'));
  udp.send(frame, remote.port, remote.address);
}

function logMissionRxFrame(frame: MavlinkFrame, label: string): void {
  console.log(`RX MAVLink ${label} msg=${frame.messageId} mavlink=${frame.version} rxSeq=${frame.sequence} sys=${frame.systemId} comp=${frame.componentId} bytes=${frame.raw.length} hex=${frame.raw.toString('hex')}`);
  logEventFromFrame(frame, null, 'info', 'mission', 'mission_rx', label, {
    messageId: frame.messageId,
    mavlink: frame.version,
    rxSeq: frame.sequence,
    bytes: frame.raw.length
  }, null, null, frame.raw.toString('hex'));
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
  logEventFromState('info', 'mission', 'readback_started', `Mission readback started: ${reason}`, {
    reason,
    timeoutMs: MISSION_READBACK_TIMEOUT_MS
  });
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
  logEventFromState(status === 'complete' ? 'info' : 'warn', 'mission', 'readback_finished', `Mission readback ${status}`, {
    status,
    expected: missionReadbackExpectedCount,
    received: items.length,
    reason: missionReadbackReason
  });
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
      pendingCaptureMissionId = null;
      pendingCapturePlan = [];
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
  if (pendingCaptureMissionId) {
    currentCaptureMissionId = pendingCaptureMissionId;
    captureStore.savePlan(pendingCaptureMissionId, pendingCapturePlan);
    const capturePlan = captureStore.getMissionStatus(pendingCaptureMissionId);
    broadcastPi('capture.plan', {
      missionId: pendingCaptureMissionId,
      plans: pendingCapturePlan
    });
    broadcast('capture.plan', capturePlan);
    logEventFromState('info', 'capture', 'plan_ready', `Capture plan ready ${pendingCaptureMissionId}`, {
      missionId: pendingCaptureMissionId,
      capturePoints: pendingCapturePlan.length
    });
  }
  broadcast('mission.uploaded', { success: true, source, missionId: currentCaptureMissionId });
  console.log(`Mission waypoints written successfully via ${source}; ready to start`);
  logEventFromState('info', 'mission', 'upload_completed', `Mission upload completed via ${source}`, {
    source,
    itemCount: items.length,
    captureMissionId: currentCaptureMissionId,
    capturePoints: pendingCapturePlan.length
  });
  pendingCaptureMissionId = null;
  pendingCapturePlan = [];
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
    if (expectedItem.type === 'aux') {
      if (actualItem.command !== 181) return false;
      if (Math.round(actualItem.param1) !== expectedItem.relay) return false;
      continue;
    }
    if (actualItem.command !== 16) return false;
    if (expectedItem.type === 'home') continue;
    if (Math.abs(actualItem.lat - expectedItem.lat) > 0.00001) return false;
    if (Math.abs(actualItem.lng - expectedItem.lng) > 0.00001) return false;
    if (expectedItem.type === 'waypoint' && Math.round(actualItem.param1) !== sanitizeWaitSeconds(expectedItem.waitSeconds)) return false;
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
    pendingCaptureMissionId = null;
    pendingCapturePlan = [];
    store.setMissionStatus('idle');
    broadcast('mission.uploaded', { success: false, result });
    console.log(`Mission upload failed: type=${type} result=${result}`);
    logEventFromState('warn', 'mission', 'upload_failed', `Mission upload failed result=${result}`, {
      ackType: type,
      result
    });
    startMissionReadback(`upload-ack-failed-${result}`);
  }
}

function uploadMission(waypoints: Waypoint[], loopCount = 1): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };
  if (waypoints.length === 0) return { ok: false, message: 'No waypoints' };

  const built = buildMissionItems(waypoints, loopCount, state);
  const missionItems = built.items;
  const remote = state.remote;
  missionUploadInProgress = false;
  pendingMissionItems = missionItems;
  lastUploadMissionItems = missionItems;
  pendingCaptureMissionId = built.missionId;
  pendingCapturePlan = built.capturePlan;
  store.setMissionStatus('uploading');
  logEventFromState('info', 'mission', 'upload_started', `Mission upload started with ${missionItems.length} items`, {
    waypointCount: waypoints.length,
    itemCount: missionItems.length,
    loopCount,
    captureMissionId: built.missionId,
    capturePoints: built.capturePlan.length,
    waypointWaits: missionItems
      .filter((item): item is Waypoint & { type: 'waypoint'; altitude?: number } => item.type === 'waypoint')
      .map((item) => ({ order: item.order, waitSeconds: sanitizeWaitSeconds(item.waitSeconds) }))
  });

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
    console.log(`Uploading mission with ${missionItems.length} items (${waypoints.length} waypoints, loop=${loopCount}, capture=${built.capturePlan.length})`);
  }, MISSION_CLEAR_BEFORE_UPLOAD_DELAY_MS);

  return { ok: true, message: 'Mission upload started' };
}

function startMissionUploadTimeout(): void {
  clearMissionUploadTimeout();
  missionUploadTimer = setTimeout(() => {
    if (!missionUploadInProgress) return;
    missionUploadInProgress = false;
    pendingCaptureMissionId = null;
    pendingCapturePlan = [];
    console.log(`Mission upload timeout after ${MISSION_UPLOAD_TIMEOUT_MS}ms waiting for MISSION_ACK`);
    logEventFromState('warn', 'mission', 'upload_timeout', `Mission upload timeout after ${MISSION_UPLOAD_TIMEOUT_MS}ms`, {
      timeoutMs: MISSION_UPLOAD_TIMEOUT_MS,
      pendingItems: pendingMissionItems.length
    });
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

function buildMissionItems(waypoints: Waypoint[], loopCount: number, state: UsvState): MissionBuildResult {
  const sanitizedLoopCount = Math.max(1, Math.min(10, Math.round(loopCount || 1)));
  const homeLat = state.lat ?? waypoints[0].lat;
  const homeLng = state.lng ?? waypoints[0].lng;
  const missionId = createMissionId();
  const capturePlan: CapturePlanInput[] = [];
  const items: MissionItem[] = [{
    type: 'home',
    order: 0,
    lat: homeLat,
    lng: homeLng,
    altitude: state.gpsAltitude ?? 0
  }];

  let capturePointIndex = 0;
  for (const [index, point] of waypoints.entries()) {
    const isCapturePoint = point.captureEnabled === true;
    const waypointSeq = items.length;
    const normalizedPoint: Waypoint & { type: 'waypoint'; altitude?: number } = {
      ...point,
      order: index + 1,
      type: 'waypoint',
      captureEnabled: isCapturePoint,
      capturePointIndex: isCapturePoint ? capturePointIndex + 1 : undefined,
      expectedPhotoCount: sanitizeExpectedPhotoCount(point.expectedPhotoCount),
      captureStepDeg: sanitizeCaptureStepDeg(point.captureStepDeg),
      waitSeconds: isCapturePoint
        ? sanitizeWaitSeconds(point.waitSeconds ?? CAPTURE_DEFAULT_WAIT_SECONDS)
        : sanitizeWaitSeconds(point.waitSeconds)
    };
    items.push(normalizedPoint);
    if (isCapturePoint) {
      capturePointIndex += 1;
      capturePlan.push({
        missionId,
        deviceId: state.deviceId,
        capturePointIndex,
        waypointSeq,
        lat: point.lat,
        lng: point.lng,
        waitSeconds: sanitizeWaitSeconds(normalizedPoint.waitSeconds),
        expectedPhotoCount: normalizedPoint.expectedPhotoCount ?? CAPTURE_DEFAULT_PHOTO_COUNT,
        captureStepDeg: normalizedPoint.captureStepDeg ?? CAPTURE_DEFAULT_STEP_DEG
      });
      items.push({
        type: 'aux',
        order: items.length,
        capturePointIndex,
        relay: sanitizeRelay(CAPTURE_AUX_RELAY),
        pulseSeconds: sanitizePulseSeconds(CAPTURE_AUX_PULSE_SECONDS)
      });
    }
  }

  if (sanitizedLoopCount > 1 && waypoints.length > 0) {
    items.push({
      type: 'doJump',
      order: items.length + 1,
      target: 1,
      repeat: sanitizedLoopCount - 1
    });
  }

  if (homeState.point) {
    items.push({
      type: 'returnHome',
      order: items.length,
      lat: homeState.point.lat,
      lng: homeState.point.lng,
      altitude: homeState.point.altitude ?? state.gpsAltitude ?? 0
    });
  }

  return {
    missionId: capturePlan.length > 0 ? missionId : null,
    items,
    capturePlan
  };
}

function sanitizeWaitSeconds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(WAYPOINT_WAIT_MIN_SECONDS, Math.min(WAYPOINT_WAIT_MAX_SECONDS, Math.round(numeric)));
}

function sanitizeExpectedPhotoCount(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? CAPTURE_DEFAULT_PHOTO_COUNT);
  if (!Number.isFinite(numeric)) return CAPTURE_DEFAULT_PHOTO_COUNT;
  return Math.max(1, Math.min(200, Math.round(numeric)));
}

function sanitizeCaptureStepDeg(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? CAPTURE_DEFAULT_STEP_DEG);
  if (!Number.isFinite(numeric)) return CAPTURE_DEFAULT_STEP_DEG;
  return Math.max(1, Math.min(360, Math.round(numeric)));
}

function sanitizePositiveInt(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.round(numeric));
}

function sanitizeCaptureDate(value: string, takenAt?: string | null): string {
  if (/^\d{8}$/.test(value)) return value;
  const parsed = takenAt ? new Date(takenAt) : new Date();
  if (!Number.isNaN(parsed.getTime())) return formatCaptureDate(parsed);
  return formatCaptureDate(new Date());
}

function formatCaptureDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function sanitizeRelay(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(15, Math.round(numeric)));
}

function sanitizePulseSeconds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 1);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0.1, Math.min(30, numeric));
}

function createMissionId(): string {
  return `mission-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTestCapturePlan(input: unknown): { code: number; data: { missionId: string | null; deviceId: string; captureDate: string; points: CapturePointStatus[] }; message: string } {
  const payload = input as Partial<{
    deviceId: string;
    lat: number;
    lng: number;
    waitSeconds: number;
    expectedPhotoCount: number;
    captureStepDeg: number;
  }>;
  const state = store.getState();
  const deviceId = String(payload.deviceId || state.deviceId || 'usv-001');
  const captureDate = formatCaptureDate(new Date());
  const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : state.lat ?? 0;
  const lng = Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : state.lng ?? 0;
  const point = captureStore.ensureDailyPoint({
    deviceId,
    captureDate,
    pointIndex: 1,
    lat,
    lng,
    waitSeconds: sanitizeWaitSeconds(payload.waitSeconds ?? CAPTURE_DEFAULT_WAIT_SECONDS),
    expectedPhotoCount: sanitizeExpectedPhotoCount(payload.expectedPhotoCount ?? CAPTURE_DEFAULT_PHOTO_COUNT),
    captureStepDeg: sanitizeCaptureStepDeg(payload.captureStepDeg ?? CAPTURE_DEFAULT_STEP_DEG)
  });
  const status = captureStore.getDailyStatus(deviceId, captureDate);
  broadcastPi('capture.plan', {
    deviceId,
    captureDate,
    points: status.points.map((item) => item.plan)
  });
  broadcast('capture.plan', status);
  logEventFromState('info', 'capture', 'test_plan_created', `Test capture point created date=${captureDate} point=1`, {
    deviceId,
    captureDate,
    pointIndex: 1,
    expectedPhotoCount: point.plan.expected_photo_count
  });
  return {
    code: 200,
    message: 'test capture plan created',
    data: status
  };
}

function handleMissionReached(seq: number): void {
  const mission = store.getMissionState();
  const finalSeq = mission.totalWaypoints - 1;
  if (mission.status !== 'active' || seq !== finalSeq || !homeState.point) return;
  const finalItem = mission.waypoints[finalSeq];
  if (!finalItem || finalItem.type !== 'returnHome') return;

  returnHomeState = {
    active: false,
    reason: 'mission_complete',
    startedAt: returnHomeState.startedAt,
    completedAt: new Date().toISOString(),
    lastDistanceMeters: distanceToHome(store.getState())
  };
  const state = store.getState();
  if (state.online && state.remote) {
    for (const frame of buildSetMode(state.systemId, state.componentId || 1, 'hold', state.autopilot)) {
      udp.send(frame, state.remote.port, state.remote.address);
    }
  }
  store.setMissionStatus('completed');
  broadcast('mission.completed', { reason: 'mission-final-home', seq });
  logEventFromState('info', 'mission', 'completed_at_home', 'Mission completed at return home; HOLD sent', {
    seq,
    home: homeState.point,
    distanceMeters: returnHomeState.lastDistanceMeters
  });
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
  logEventFromState('info', 'mission', 'paused', 'Mission paused');
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
  logEventFromState('info', 'mission', 'started', 'Mission started', {
    currentSeq: 1,
    totalWaypoints: mission.totalWaypoints
  });
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
  logEventFromState('info', 'mission', 'resumed', 'Mission resumed');
  return { ok: true, message: 'Mission resumed' };
}

function clearMission(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };

  const frame = buildMissionClearAll(state.systemId, state.componentId || 1);
  missionUploadInProgress = false;
  pendingMissionItems = [];
  lastUploadMissionItems = [];
  pendingCaptureMissionId = null;
  pendingCapturePlan = [];
  currentCaptureMissionId = null;
  clearMissionUploadTimers();
  sendMissionFrame(frame, 'MISSION_CLEAR_ALL');
  store.clearMission();
  broadcast('mission.cleared', {});
  broadcast('capture.plan', { missionId: null, points: [] });
  logEventFromState('info', 'mission', 'cleared', 'Mission cleared');
  return { ok: true, message: 'Mission cleared' };
}

function requestMissionReadback(reason: string): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline' };
  startMissionReadback(reason);
  return { ok: true, message: 'Mission readback requested' };
}

async function handleCaptureUpload(req: http.IncomingMessage): Promise<{ ok: boolean; status: number; body: unknown }> {
  const contentTypeHeader = req.headers['content-type'] ?? '';
  const boundary = String(contentTypeHeader).match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    ?? String(contentTypeHeader).match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) return { ok: false, status: 400, body: { code: 400, message: 'multipart boundary missing' } };

  const parts = parseMultipart(await readRawBody(req), boundary);
  const field = (name: string) => parts.find((part) => part.name === name && !part.filename)?.data.toString('utf8').trim() ?? '';
  const file = parts.find((part) => part.filename);
  if (!file) return { ok: false, status: 400, body: { code: 400, message: 'image file missing' } };

  const state = store.getState();
  const deviceId = field('deviceId') || state.deviceId || 'usv-001';
  const takenAt = field('takenAt') || null;
  const captureDate = sanitizeCaptureDate(field('captureDate'), takenAt);
  const pointIndex = sanitizePositiveInt(field('pointIndex') || field('capturePointIndex'), 1);
  const photoIndex = sanitizePositiveInt(field('photoIndex'), 0);
  if (photoIndex <= 0) return { ok: false, status: 400, body: { code: 400, message: 'photoIndex missing or invalid' } };
  const angleDegRaw = field('angleDeg');
  const angleDeg = angleDegRaw ? Number(angleDegRaw) : null;
  const filePath = captureStore.makeDailyImagePath(deviceId, captureDate, pointIndex, photoIndex, file.filename ?? null);
  await writeFile(filePath, file.data);
  const pointStatus = captureStore.insertDailyImage({
    deviceId,
    captureDate,
    pointIndex,
    photoIndex,
    angleDeg: Number.isFinite(angleDeg) ? angleDeg : null,
    takenAt,
    filePath,
    originalName: file.filename ?? null,
    mimeType: file.contentType ?? null,
    sizeBytes: file.data.length
  });
  const image = captureStore.getDailyImage(deviceId, captureDate, pointIndex, photoIndex);
  if (image) {
    if (aiDetectionEnabled) {
      captureStore.queueDetection(image.id, OUTFALL_MODEL_PATH);
      void processDetectionQueue();
      logEventFromState('info', 'capture', 'detection_queued', `Outfall detection queued image=${image.id}`, {
        imageId: image.id,
        deviceId,
        captureDate,
        pointIndex,
        photoIndex,
        modelPath: OUTFALL_MODEL_PATH
      });
    } else {
      captureStore.skipDetection(image.id);
      logEventFromState('info', 'capture', 'detection_skipped', `Outfall detection skipped image=${image.id}`, {
        imageId: image.id,
        deviceId,
        captureDate,
        pointIndex,
        photoIndex
      });
    }
  }
  const captureStatus = captureStore.getDailyStatus(deviceId, captureDate);
  broadcast('capture.updated', captureStatus);
  logEventFromState('info', 'capture', 'image_uploaded', `Capture image uploaded date=${captureDate} point=${pointIndex} photo=${photoIndex}`, {
    deviceId,
    captureDate,
    pointIndex,
    photoIndex,
    angleDeg: Number.isFinite(angleDeg) ? angleDeg : null,
    sizeBytes: file.data.length,
    missing: pointStatus?.missing
  });

  return {
    ok: true,
    status: 200,
    body: {
      code: 200,
      data: {
        deviceId,
        captureDate,
        pointIndex,
        received: pointStatus.received,
        missing: pointStatus.missing,
        complete: pointStatus.complete
      }
    }
  };
}

function handleCaptureStatus(input: unknown): CapturePointStatus | null {
  const data = input as Partial<{ missionId: string; deviceId: string; capturePointIndex: number; captureDate: string; pointIndex: number; status: string }>;
  const deviceId = data.deviceId || store.getState().deviceId;
  const status = captureStore.markActivity({
    captureDate: data.captureDate,
    pointIndex: data.pointIndex,
    missionId: data.missionId,
    deviceId,
    capturePointIndex: data.capturePointIndex == null ? undefined : Number(data.capturePointIndex),
    status: data.status || 'shooting'
  });
  if (status) {
    if (data.captureDate) broadcast('capture.updated', captureStore.getDailyStatus(deviceId, data.captureDate));
    else if (data.missionId) broadcast('capture.updated', captureStore.getMissionStatus(data.missionId));
  }
  return status;
}

function runCaptureCompletenessChecks(): void {
  const due = captureStore.listDueChecks(CAPTURE_UPLOAD_CHECK_DELAY_SECONDS, CAPTURE_REUPLOAD_MAX_ATTEMPTS);
  for (const point of due) {
    if (point.missing.length === 0) {
      if (point.plan.capture_date && point.plan.point_index) {
        captureStore.setDailyPointStatus(point.plan.device_id, point.plan.capture_date, point.plan.point_index, 'complete');
      } else {
        captureStore.setPointStatus(point.plan.mission_id, point.plan.capture_point_index, 'complete');
      }
      continue;
    }
    captureStore.recordReuploadAttempt(point.plan);
    const command = point.plan.capture_date && point.plan.point_index
      ? {
          deviceId: point.plan.device_id,
          captureDate: point.plan.capture_date,
          pointIndex: point.plan.point_index,
          missing: point.missing
        }
      : {
          missionId: point.plan.mission_id,
          deviceId: point.plan.device_id,
          capturePointIndex: point.plan.capture_point_index,
          missing: point.missing
        };
    broadcastPi('capture.reupload', command);
    broadcast('capture.updated', point.plan.capture_date
      ? captureStore.getDailyStatus(point.plan.device_id, point.plan.capture_date)
      : captureStore.getMissionStatus(point.plan.mission_id));
    logEventFromState('warn', 'capture', 'reupload_requested', `Capture reupload requested point=${point.plan.point_index ?? point.plan.capture_point_index}`, {
      ...command,
      attempt: point.plan.reupload_attempts + 1
    });
  }
  for (const point of captureStore.markIncompleteAfterMax(CAPTURE_REUPLOAD_MAX_ATTEMPTS)) {
    broadcast('capture.updated', point.plan.capture_date
      ? captureStore.getDailyStatus(point.plan.device_id, point.plan.capture_date)
      : captureStore.getMissionStatus(point.plan.mission_id));
    logEventFromState('warn', 'capture', 'incomplete', `Capture point incomplete point=${point.plan.point_index ?? point.plan.capture_point_index}`, {
      deviceId: point.plan.device_id,
      captureDate: point.plan.capture_date,
      pointIndex: point.plan.point_index,
      missing: point.missing,
      attempts: point.plan.reupload_attempts
    });
  }
}

setInterval(runCaptureCompletenessChecks, 30_000);

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/state') {
    return sendJson(res, 200, { code: 200, data: publicState() });
  }

  if (url.pathname === '/api/mission') {
    return sendJson(res, 200, { code: 200, data: store.getMissionState() });
  }

  if (url.pathname === '/api/home' && req.method === 'GET') {
    return sendJson(res, 200, { code: 200, data: publicHomeState() });
  }

  if (url.pathname === '/api/home' && req.method === 'POST') {
    const body = await readBody(req);
    const result = setHomeFromInput(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/logs/events') {
    return sendJson(res, 200, { code: 200, data: eventLog.queryEvents(eventQueryFromUrl(url)) });
  }

  if (url.pathname === '/api/logs/telemetry') {
    return sendJson(res, 200, { code: 200, data: eventLog.queryTelemetry(telemetryQueryFromUrl(url)) });
  }

  if (url.pathname === '/api/logs/export.csv') {
    const kind = url.searchParams.get('kind') === 'telemetry' ? 'telemetry' : 'events';
    const csv = kind === 'telemetry'
      ? eventLog.exportTelemetryCsv(telemetryQueryFromUrl(url))
      : eventLog.exportEventsCsv(eventQueryFromUrl(url));
    return sendCsv(res, `usv-${kind}-${new Date().toISOString().replaceAll(':', '-')}.csv`, csv);
  }

  if (url.pathname === '/api/capture-plan/current') {
    const data = captureStore.getCurrentPlan(url.searchParams.get('deviceId'));
    return sendJson(res, 200, { code: 200, data });
  }

  if (url.pathname === '/api/pi/status') {
    return sendJson(res, 200, { code: 200, data: publicPiStatus(url.searchParams.get('deviceId')) });
  }

  if (url.pathname === '/api/detections/settings' && req.method === 'GET') {
    return sendJson(res, 200, { code: 200, data: publicDetectionSettings() });
  }

  if (url.pathname === '/api/detections/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const result = updateDetectionSettings(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/capture-plan/test' && req.method === 'POST') {
    const body = await readBody(req);
    const result = createTestCapturePlan(body);
    return sendJson(res, 200, result);
  }

  if (url.pathname === '/api/captures') {
    const deviceId = url.searchParams.get('deviceId');
    const captureDate = url.searchParams.get('captureDate');
    const missionId = url.searchParams.get('missionId');
    if (missionId) return sendJson(res, 200, { code: 200, data: captureStore.getMissionStatus(missionId) });
    return sendJson(res, 200, { code: 200, data: captureStore.getCurrentCapture(deviceId, captureDate) });
  }

  if (url.pathname === '/api/captures/upload' && req.method === 'POST') {
    const result = await handleCaptureUpload(req);
    return sendJson(res, result.status, result.body);
  }

  if (url.pathname === '/api/captures/reupload' && req.method === 'POST') {
    const body = await readBody(req);
    const result = requestManualCaptureReupload(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  const detectMatch = url.pathname.match(/^\/api\/captures\/(\d+)\/detect$/);
  if (detectMatch && req.method === 'POST') {
    const result = requestCaptureDetection(Number(detectMatch[1]));
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname === '/api/camera/trigger' && req.method === 'POST') {
    const body = await readBody(req);
    const result = triggerCameraRelay(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  const imageMatch = url.pathname.match(/^\/api\/captures\/(\d+)\/original$/);
  if (imageMatch && req.method === 'GET') {
    const image = captureStore.openImage(Number(imageMatch[1]));
    if (!image) return sendJson(res, 404, { code: 404, message: 'image not found' });
    res.writeHead(200, {
      'Content-Type': image.row.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="capture-${image.row.id}${extname(image.row.file_path) || ''}"`,
      'Access-Control-Allow-Origin': '*'
    });
    image.stream.pipe(res);
    return;
  }

  const annotatedMatch = url.pathname.match(/^\/api\/captures\/(\d+)\/annotated$/);
  if (annotatedMatch && req.method === 'GET') {
    const image = captureStore.openAnnotatedImage(Number(annotatedMatch[1]));
    if (!image) return sendJson(res, 404, { code: 404, message: 'annotated image not found' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Disposition': `inline; filename="capture-${image.row.id}-detected.jpg"`,
      'Access-Control-Allow-Origin': '*'
    });
    image.stream.pipe(res);
    return;
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

  if (url.pathname === '/api/command-line' && req.method === 'POST') {
    const body = await readBody(req);
    const result = handleCommandLine(body);
    return sendJson(res, result.ok ? 200 : 400, result);
  }

  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { code: 404, message: 'not found' });
  }

  return serveClient(req, res);
});

const wss = new WebSocketServer({ noServer: true });
const piWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const target = url.pathname === '/ws'
    ? wss
    : url.pathname === '/api/pi/ws'
      ? piWss
      : null;

  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  clients.add(ws);
  sendWs(ws, 'usv.telemetry', publicState());
  sendWs(ws, 'home.updated', publicHomeState());
  sendWs(ws, 'return.home', publicReturnHomeState());
  sendWs(ws, 'detections.settings', publicDetectionSettings());
  sendWs(ws, 'capture.updated', captureStore.getCurrentCapture());

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
      if (message.type === 'control.returnHome') {
        const result = handleControl({ action: 'returnHome' });
        if (!result.ok) sendWs(ws, 'error', { message: result.message });
      }
      if (message.type === 'control.reboot') {
        const data = message.data as { confirmed?: boolean };
        const result = handleControl({ action: 'reboot', confirmed: data?.confirmed });
        if (!result.ok) sendWs(ws, 'error', { message: result.message });
      }
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

piWss.on('connection', (ws) => {
  piClients.set(ws, {
    connectedAt: new Date().toISOString(),
    registeredAt: null,
    deviceId: null,
    piId: null,
    firmwareVersion: null,
    cameraCount: null,
    lastHeartbeatAt: null,
    lastMessageType: null,
    lastMessageAt: null,
    lastCaptureStatus: null,
    lastReuploadResult: null
  });
  sendWs(ws, 'capture.plan', captureStore.getCurrentCapture());

  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: unknown };
      updatePiClient(ws, message.type || 'unknown');
      if (message.type === 'pi.register') {
        const data = message.data as Partial<{ deviceId: string; piId: string; firmwareVersion: string; cameraCount: number }> | undefined;
        updatePiClient(ws, 'pi.register', {
          registeredAt: new Date().toISOString(),
          deviceId: data?.deviceId ?? store.getState().deviceId,
          piId: data?.piId ?? null,
          firmwareVersion: data?.firmwareVersion ?? null,
          cameraCount: typeof data?.cameraCount === 'number' ? data.cameraCount : null
        });
        sendWs(ws, 'pi.registered', {
          deviceId: data?.deviceId ?? store.getState().deviceId,
          currentMissionId: currentCaptureMissionId
        });
        sendWs(ws, 'capture.plan', captureStore.getCurrentCapture(data?.deviceId));
        logEventFromState('info', 'capture', 'pi_registered', 'Raspberry Pi registered', message.data as Record<string, unknown>);
        return;
      }
      if (message.type === 'pi.heartbeat') {
        updatePiClient(ws, 'pi.heartbeat', { lastHeartbeatAt: new Date().toISOString() });
        sendWs(ws, 'pi.heartbeat', { ok: true });
        return;
      }
      if (message.type === 'capture.status') {
        updatePiClient(ws, 'capture.status', { lastCaptureStatus: message.data });
        const status = handleCaptureStatus(message.data);
        sendWs(ws, 'capture.status', { ok: !!status, status });
        return;
      }
      if (message.type === 'capture.reupload.result') {
        updatePiClient(ws, 'capture.reupload.result', { lastReuploadResult: message.data });
        logEventFromState('info', 'capture', 'reupload_result', 'Capture reupload result', message.data as Record<string, unknown>);
        return;
      }
      sendWs(ws, 'error', { message: 'unknown pi message type' });
    } catch {
      sendWs(ws, 'error', { message: 'Invalid WebSocket message' });
    }
  });

  ws.on('close', () => {
    piClients.delete(ws);
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP/WebSocket listening on http://127.0.0.1:${HTTP_PORT}`);
  void processDetectionQueue();
});

function shutdown(signal: string): void {
  logEventFromState('info', 'service', 'shutdown', `USV service stopping (${signal})`, { signal });
  eventLog.close();
  captureStore.close();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

setInterval(() => {
  broadcastState();
  observeOnlineState();
  observeReturnHomeArrival();
  sampleTelemetry();
  if (lastManualInputAt > 0 && Date.now() - lastManualInputAt > CONTROL_TIMEOUT_MS) {
    if (Date.now() - lastSentZeroAt > CONTROL_TIMEOUT_MS) {
      sendManualControl({ throttle: 0, steering: 0 }, false);
      lastSentZeroAt = Date.now();
    }
  }
}, 250);

function handleControl(body: unknown): { ok: boolean; message: string } {
  const payload = body as { action?: string; throttle?: number; steering?: number; mode?: string; confirmed?: boolean };
  if (payload.action === 'arm') return sendArm(true);
  if (payload.action === 'disarm') return sendArm(false);
  if (payload.action === 'emergencyStop') return sendEmergencyStop();
  if (payload.action === 'returnHome') return startReturnHome('manual');
  if (payload.action === 'reboot') {
    if (payload.confirmed !== true) return { ok: false, message: 'reboot requires confirmation' };
    return sendRebootAutopilot();
  }
  if (payload.action === 'setMode') return sendSetMode(String(payload.mode ?? ''));
  if (payload.action === 'manual') {
    return sendManualControl({
      throttle: Number(payload.throttle ?? 0),
      steering: Number(payload.steering ?? 0)
    });
  }
  return { ok: false, message: 'unknown action' };
}

function publicDetectionSettings(): { enabled: boolean; modelPath: string; confidence: number } {
  return {
    enabled: aiDetectionEnabled,
    modelPath: OUTFALL_MODEL_PATH,
    confidence: OUTFALL_CONFIDENCE
  };
}

function updateDetectionSettings(input: unknown): { ok: boolean; message: string; data: { enabled: boolean; modelPath: string; confidence: number } } {
  const payload = input as { enabled?: unknown };
  if (typeof payload.enabled !== 'boolean') {
    return {
      ok: false,
      message: 'enabled must be boolean',
      data: publicDetectionSettings()
    };
  }

  const previous = aiDetectionEnabled;
  aiDetectionEnabled = payload.enabled;
  const settings = publicDetectionSettings();
  broadcast('detections.settings', settings);

  if (previous !== aiDetectionEnabled) {
    logEventFromState('info', 'capture', aiDetectionEnabled ? 'detection_enabled' : 'detection_disabled',
      aiDetectionEnabled ? 'Outfall AI detection enabled' : 'Outfall AI detection disabled',
      settings);
  }

  return {
    ok: true,
    message: aiDetectionEnabled ? 'AI detection enabled' : 'AI detection disabled',
    data: settings
  };
}

function requestCaptureDetection(imageId: number): { ok: boolean; message: string; data?: Record<string, unknown> } {
  if (!aiDetectionEnabled) return { ok: false, message: 'AI detection disabled' };
  const image = captureStore.getImage(imageId);
  if (!image) return { ok: false, message: 'image not found' };
  const detection = captureStore.queueDetection(image.id, OUTFALL_MODEL_PATH);
  void processDetectionQueue();
  logEventFromState('info', 'capture', 'detection_queued', `Outfall detection queued image=${image.id}`, {
    imageId: image.id,
    deviceId: image.device_id,
    captureDate: image.capture_date,
    pointIndex: image.point_index,
    photoIndex: image.photo_index,
    modelPath: OUTFALL_MODEL_PATH,
    manual: true
  });
  if (image.capture_date) broadcast('capture.updated', captureStore.getDailyStatus(image.device_id, image.capture_date));
  return {
    ok: true,
    message: 'AI detection queued',
    data: { detection }
  };
}

async function processDetectionQueue(): Promise<void> {
  if (detectionWorkerRunning) return;
  detectionWorkerRunning = true;
  try {
    while (true) {
      const next = captureStore.listPendingDetections(1)[0];
      if (!next) break;
      const image = captureStore.getImage(next.image_id);
      if (!image) {
        captureStore.markDetectionFailed(next.image_id, 'image not found');
        continue;
      }
      await runCaptureDetection(image.id);
    }
  } finally {
    detectionWorkerRunning = false;
  }
}

async function runCaptureDetection(imageId: number): Promise<void> {
  const image = captureStore.getImage(imageId);
  if (!image) {
    captureStore.markDetectionFailed(imageId, 'image not found');
    return;
  }

  const annotatedPath = captureStore.makeAnnotatedImagePath(image);
  captureStore.markDetectionRunning(image.id, null);
  broadcastCaptureForImage(image);

  try {
    await access(resolve(OUTFALL_MODEL_PATH), fsConstants.R_OK);
    await access(resolve(OUTFALL_DETECTION_SCRIPT), fsConstants.R_OK);
    const result = await runOutfallDetector({
      modelPath: resolve(OUTFALL_MODEL_PATH),
      imagePath: image.file_path,
      annotatedPath,
      confidence: OUTFALL_CONFIDENCE
    });
    const detectionsJson = JSON.stringify(result.detections ?? []);
    const detection = captureStore.markDetectionComplete({
      imageId: image.id,
      modelPath: OUTFALL_MODEL_PATH,
      device: result.device ?? null,
      inferenceMs: typeof result.inference_ms === 'number' ? result.inference_ms : null,
      detectionsJson,
      detectedCount: Array.isArray(result.detections) ? result.detections.length : 0,
      annotatedPath
    });
    logEventFromState('info', 'capture', 'detection_complete', `Outfall detection complete image=${image.id}`, {
      imageId: image.id,
      deviceId: image.device_id,
      captureDate: image.capture_date,
      pointIndex: image.point_index,
      photoIndex: image.photo_index,
      detectedCount: detection?.detected_count ?? 0,
      inferenceMs: detection?.inference_ms ?? null,
      annotatedPath
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    captureStore.markDetectionFailed(image.id, message);
    logEventFromState('warn', 'capture', 'detection_failed', `Outfall detection failed image=${image.id}`, {
      imageId: image.id,
      deviceId: image.device_id,
      captureDate: image.capture_date,
      pointIndex: image.point_index,
      photoIndex: image.photo_index,
      error: message
    });
  } finally {
    broadcastCaptureForImage(image);
  }
}

type OutfallDetectorResult = {
  model_path?: string;
  device?: string;
  inference_ms?: number;
  detections?: unknown[];
  annotated_path?: string;
};

function runOutfallDetector(input: {
  modelPath: string;
  imagePath: string;
  annotatedPath: string;
  confidence: number;
}): Promise<OutfallDetectorResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(OUTFALL_DETECTION_PYTHON, [
      OUTFALL_DETECTION_SCRIPT,
      '--model',
      input.modelPath,
      '--image',
      input.imagePath,
      '--output',
      input.annotatedPath,
      '--conf',
      String(input.confidence)
    ], {
      cwd: process.cwd(),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `detector exited with code ${code}`).trim()));
        return;
      }
      try {
        const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
        if (!lastLine) throw new Error('detector returned empty output');
        resolvePromise(JSON.parse(lastLine) as OutfallDetectorResult);
      } catch (error) {
        reject(new Error(`failed to parse detector output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function broadcastCaptureForImage(image: { device_id: string; capture_date: string | null; mission_id: string }): void {
  if (image.capture_date) {
    broadcast('capture.updated', captureStore.getDailyStatus(image.device_id, image.capture_date));
  } else {
    broadcast('capture.updated', captureStore.getMissionStatus(image.mission_id));
  }
}

function handleCommandLine(body: unknown): { ok: boolean; message: string; data?: Record<string, unknown> } {
  const payload = body as { command?: string };
  const input = String(payload.command || '').trim();
  if (!input) return { ok: false, message: 'command is empty' };

  const tokens = input.split(/\s+/);
  const verb = tokens[0]?.toLowerCase();
  const args = tokens.slice(1);
  const state = store.getState();

  const logCommand = (ok: boolean, message: string, details: Record<string, unknown> = {}) => {
    logEventFromState(ok ? 'info' : 'warn', 'control', 'command_line', message, {
      input,
      ...details
    });
  };

  try {
    if (verb === 'arm') return withCommandLog(sendArm(true), logCommand, { action: 'arm' });
    if (verb === 'disarm') return withCommandLog(sendArm(false), logCommand, { action: 'disarm' });
    if (verb === 'stop' || verb === 'emergency' || verb === 'emergencystop') {
      return withCommandLog(sendEmergencyStop(), logCommand, { action: 'emergencyStop' });
    }
    if (verb === 'return' || verb === 'rtl') {
      return withCommandLog(startReturnHome('command_line'), logCommand, { action: 'returnHome' });
    }
    if (verb === 'reboot') {
      if (args[0]?.toLowerCase() !== 'confirm') {
        const result = { ok: false, message: 'reboot requires: reboot confirm' };
        logCommand(false, result.message, { action: 'reboot' });
        return result;
      }
      return withCommandLog(sendRebootAutopilot(), logCommand, { action: 'reboot' });
    }
    if (verb === 'mode') {
      const mode = args[0];
      if (!mode) return { ok: false, message: 'mode required, e.g. mode hold' };
      return withCommandLog(sendSetMode(mode), logCommand, { action: 'setMode', mode });
    }
    if (verb === 'manual') {
      const throttle = Number(args[0] ?? 0);
      const steering = Number(args[1] ?? 0);
      if (!Number.isFinite(throttle) || !Number.isFinite(steering)) {
        const result = { ok: false, message: 'manual requires numeric throttle steering' };
        logCommand(false, result.message, { action: 'manual' });
        return result;
      }
      return withCommandLog(sendManualControl({ throttle, steering }), logCommand, { action: 'manual', throttle, steering });
    }
    if (verb === 'camera') {
      return withCommandLog(triggerCameraRelay({}), logCommand, { action: 'cameraTrigger' });
    }
    if (verb === 'relay') {
      const relay = sanitizeRelay(args[0]);
      const enabled = args[1] === '1' || args[1]?.toLowerCase() === 'on' || args[1]?.toLowerCase() === 'high';
      if (!state.online || !state.remote) {
        const result = { ok: false, message: 'USV offline or remote endpoint unknown' };
        logCommand(false, result.message, { action: 'relay', relay, enabled });
        return result;
      }
      const frame = buildSetRelay(state.systemId, state.componentId || 1, relay, enabled);
      udp.send(frame, state.remote.port, state.remote.address);
      const message = `relay ${relay} ${enabled ? 'high' : 'low'} sent`;
      logEventFromState('info', 'control', 'command_line', message, {
        input,
        action: 'relay',
        relay,
        enabled
      }, 181, null, frame.toString('hex'));
      broadcast('control.sent', { action: 'commandLine', command: input });
      return { ok: true, message, data: { relay, enabled } };
    }
    if (verb === 'mavcmd') {
      const command = Number(args[0]);
      if (!Number.isInteger(command) || command < 0 || command > 65535) {
        const result = { ok: false, message: 'mavcmd requires numeric command id' };
        logCommand(false, result.message, { action: 'mavcmd' });
        return result;
      }
      if (!state.online || !state.remote) {
        const result = { ok: false, message: 'USV offline or remote endpoint unknown' };
        logCommand(false, result.message, { action: 'mavcmd', command });
        return result;
      }
      const params = args.slice(1, 8).map((value) => Number(value));
      while (params.length < 7) params.push(0);
      if (params.some((value) => !Number.isFinite(value))) {
        const result = { ok: false, message: 'mavcmd params must be numeric' };
        logCommand(false, result.message, { action: 'mavcmd', command });
        return result;
      }
      const frame = buildCommandLongGeneric(state.systemId, state.componentId || 1, command, params);
      udp.send(frame, state.remote.port, state.remote.address);
      const message = `MAV_CMD ${command} sent`;
      logEventFromState('info', 'control', 'command_line', message, {
        input,
        action: 'mavcmd',
        command,
        params
      }, command, null, frame.toString('hex'));
      broadcast('control.sent', { action: 'commandLine', command: input });
      return { ok: true, message, data: { command, params } };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'command failed';
    logCommand(false, message);
    return { ok: false, message };
  }

  const message = 'unknown command. examples: arm, disarm, mode hold, manual 0.2 0, relay 0 1, mavcmd 179 0 0 0 0 31.1 121.1 0';
  logCommand(false, message);
  return { ok: false, message };
}

function withCommandLog(
  result: { ok: boolean; message: string },
  logCommand: (ok: boolean, message: string, details?: Record<string, unknown>) => void,
  details: Record<string, unknown>
): { ok: boolean; message: string; data?: Record<string, unknown> } {
  logCommand(result.ok, result.message, details);
  if (result.ok) broadcast('control.sent', { action: 'commandLine', ...details });
  return { ...result, data: details };
}

function requestManualCaptureReupload(input: unknown): {
  ok: boolean;
  message: string;
  data?: { deviceId: string; captureDate: string; pointIndex: number; missing: number[] };
} {
  const payload = input as Partial<{
    deviceId: string;
    captureDate: string;
    pointIndex: number;
    photoIndex: number;
    missing: number[];
  }>;
  const deviceId = String(payload.deviceId || store.getState().deviceId || '').trim();
  const captureDate = String(payload.captureDate || '').trim();
  const pointIndex = sanitizePositiveInt(payload.pointIndex, 0);
  const missing = Array.isArray(payload.missing)
    ? payload.missing.map((item) => sanitizePositiveInt(item, 0)).filter((item) => item > 0)
    : [sanitizePositiveInt(payload.photoIndex, 0)].filter((item) => item > 0);

  if (!deviceId) return { ok: false, message: 'deviceId missing' };
  if (!/^\d{8}$/.test(captureDate)) return { ok: false, message: 'captureDate must be YYYYMMDD' };
  if (pointIndex <= 0) return { ok: false, message: 'pointIndex missing or invalid' };
  if (missing.length === 0) return { ok: false, message: 'photoIndex or missing required' };
  if (piClients.size === 0) return { ok: false, message: 'Raspberry Pi offline' };

  const command = {
    deviceId,
    captureDate,
    pointIndex,
    missing: [...new Set(missing)].sort((a, b) => a - b)
  };
  broadcastPi('capture.reupload', command);
  logEventFromState('warn', 'capture', 'reupload_manual', `Manual capture reupload requested point=${pointIndex}`, command);
  return {
    ok: true,
    message: 'capture reupload requested',
    data: command
  };
}

function triggerCameraRelay(input: unknown): { ok: boolean; message: string; data?: { relay: number; pulseSeconds: number } } {
  const now = Date.now();
  if (now - lastCameraTriggerAt < CAMERA_TRIGGER_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((CAMERA_TRIGGER_COOLDOWN_MS - (now - lastCameraTriggerAt)) / 1000);
    return { ok: false, message: `camera trigger cooldown ${remainingSeconds}s` };
  }

  const payload = input as { relay?: number; pulseSeconds?: number };
  const relay = sanitizeRelay(payload.relay ?? CAPTURE_AUX_RELAY);
  const pulseSeconds = sanitizePulseSeconds(payload.pulseSeconds ?? CAPTURE_AUX_PULSE_SECONDS);
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  const targetComponent = state.componentId || 1;
  const highFrame = buildSetRelay(state.systemId, targetComponent, relay, true);
  lastCameraTriggerAt = now;
  udp.send(highFrame, state.remote.port, state.remote.address);
  logEventFromState('info', 'capture', 'manual_trigger_high', `Camera trigger relay ${relay} high`, {
    relay,
    pulseSeconds,
    target: `${state.systemId}/${targetComponent}`
  }, 181, null, highFrame.toString('hex'));
  broadcast('control.sent', { action: 'cameraTrigger', relay, pulseSeconds });

  setTimeout(() => {
    const latest = store.getState();
    if (!latest.remote) {
      logEventFromState('warn', 'capture', 'manual_trigger_low', `Camera trigger relay ${relay} low skipped: remote unknown`, {
        relay,
        pulseSeconds
      }, 181);
      return;
    }
    const lowFrame = buildSetRelay(latest.systemId || state.systemId, latest.componentId || targetComponent, relay, false);
    udp.send(lowFrame, latest.remote.port, latest.remote.address);
    logEventFromState('info', 'capture', 'manual_trigger_low', `Camera trigger relay ${relay} low`, {
      relay,
      pulseSeconds,
      target: `${latest.systemId || state.systemId}/${latest.componentId || targetComponent}`
    }, 181, null, lowFrame.toString('hex'));
    broadcast('control.sent', { action: 'cameraTriggerLow', relay });
  }, Math.round(pulseSeconds * 1000));

  return {
    ok: true,
    message: 'camera trigger relay pulse sent',
    data: { relay, pulseSeconds }
  };
}

function sampleTelemetry(): void {
  const now = Date.now();
  if (now - lastTelemetrySampleAt < 1000) return;
  lastTelemetrySampleAt = now;
  const state = store.getState();
  if (!state.online && !state.lastSeen) return;

  eventLog.logTelemetry({
    deviceId: state.deviceId,
    systemId: state.systemId,
    componentId: state.componentId,
    remoteAddress: state.remote?.address ?? null,
    remotePort: state.remote?.port ?? null,
    mode: state.mode,
    armed: state.armed,
    voltage: state.voltage,
    current: lastBatteryCurrent,
    batteryPercent: state.batteryPercent,
    gpsFixType: state.gpsFixType,
    gpsFixLabel: state.gpsFixLabel,
    gpsSatellites: state.gpsSatellites,
    gpsHdop: state.gpsHdop,
    gpsVdop: state.gpsVdop,
    lat: state.lat,
    lng: state.lng,
    speed: state.speed,
    heading: state.heading
  });
}

function observeOnlineState(): void {
  const state = store.getState();
  if (lastOnlineLogged === null) {
    lastOnlineLogged = state.online;
    return;
  }
  if (state.online === lastOnlineLogged) return;
  lastOnlineLogged = state.online;
  logEventFromState(state.online ? 'info' : 'warn', 'link', state.online ? 'online' : 'offline', `USV ${state.online ? 'online' : 'offline'}`, {
    lastSeen: state.lastSeen
  });
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

  const frames = buildSetMode(state.systemId, state.componentId || 1, modeKey as never, state.autopilot);
  logControlTx('setMode', { mode: modeKey }, true, frames.at(-1)?.toString('hex') ?? null, 176);
  for (const frame of frames) {
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
  if (input.throttle !== 0 || input.steering !== 0) {
    logControlTx('manual', { throttle: input.throttle.toFixed(2), steering: input.steering.toFixed(2), markInput }, false, frames[0].toString('hex'));
  }
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
  logControlTx(arm ? 'arm' : 'disarm', {}, true, frame.toString('hex'), 400);
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

  const frames = buildEmergencyStop(state.systemId, state.componentId || 1);
  logControlTx('emergencyStop', {}, true, frames.at(-1)?.toString('hex') ?? null, 400);
  for (const frame of frames) {
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

function sendRebootAutopilot(): { ok: boolean; message: string } {
  const state = store.getState();
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };
  if (pendingRebootAfterDisarmTimer) return { ok: false, message: 'reboot is already waiting for disarm confirmation' };

  if (state.armed) {
    sendNeutralControlFrames(state);
    const frame = buildArmDisarm(state.systemId, state.componentId || 1, false);
    logControlTx('rebootAutopilotDisarm', {}, true, frame.toString('hex'), 400);
    udp.send(frame, state.remote.port, state.remote.address);
    scheduleRebootAfterDisarm();
    broadcast('control.sent', { action: 'rebootDisarmPending' });
    return { ok: true, message: 'disarm sent before reboot' };
  }

  return sendRebootAutopilotNow(state);
}

function sendRebootAutopilotNow(state = store.getState()): { ok: boolean; message: string } {
  if (!state.online || !state.remote) return { ok: false, message: 'USV offline or remote endpoint unknown' };

  sendNeutralControlFrames(state);
  const frame = buildRebootAutopilot(state.systemId, state.componentId || 1);
  const messageId = frame.length >= 10 ? frame[7] | (frame[8] << 8) | (frame[9] << 16) : -1;
  const txSeq = frame.length >= 5 ? frame[4] : -1;
  logControlTx('rebootAutopilot', {}, true, frame.toString('hex'), 246);
  console.log(`TX MAVLink PREFLIGHT_REBOOT_SHUTDOWN cmd=246 param1=1 msg=${messageId} txSeq=${txSeq} bytes=${frame.length} to=${state.remote.address}:${state.remote.port} hex=${frame.toString('hex')}`);
  udp.send(frame, state.remote.port, state.remote.address);

  broadcast('control.sent', { action: 'rebootAutopilot' });
  return { ok: true, message: 'reboot autopilot sent' };
}

function sendNeutralControlFrames(state: UsvState): void {
  if (!state.remote) return;
  for (const frame of [
    buildManualControl(state.systemId, { throttle: 0, steering: 0 }),
    buildRcChannelsOverride(state.systemId, state.componentId || 1, { throttle: 0, steering: 0 })
  ]) {
    udp.send(frame, state.remote.port, state.remote.address);
  }
}

function scheduleRebootAfterDisarm(): void {
  const deadline = Date.now() + REBOOT_DISARM_WAIT_MS;

  const checkDisarmed = () => {
    const state = store.getState();
    if (state.online && state.remote && !state.armed) {
      pendingRebootAfterDisarmTimer = null;
      sendRebootAutopilotNow(state);
      return;
    }

    if (Date.now() >= deadline) {
      pendingRebootAfterDisarmTimer = null;
      console.log(`Reboot autopilot aborted: disarm not confirmed within ${REBOOT_DISARM_WAIT_MS}ms`);
      broadcast('error', { message: '未确认上锁，已取消重启飞控' });
      return;
    }

    pendingRebootAfterDisarmTimer = setTimeout(checkDisarmed, REBOOT_DISARM_POLL_MS);
  };

  pendingRebootAfterDisarmTimer = setTimeout(checkDisarmed, REBOOT_DISARM_POLL_MS);
}

function publicState(): Omit<UsvState, 'remote'> & {
  remoteKnown: boolean;
  udpPort: number;
  mission: ReturnType<typeof store.getMissionState>;
  home: HomeState;
  returnHome: ReturnHomeState;
  capture: { missionId: string | null; captureDate?: string | null; deviceId?: string | null; points: CapturePointStatus[] };
} {
  const { remote, ...state } = store.getState();
  return {
    ...state,
    remoteKnown: remote !== null,
    udpPort: UDP_PORT,
    mission: store.getMissionState(),
    home: publicHomeState(),
    returnHome: publicReturnHomeState(),
    capture: captureStore.getCurrentCapture()
  };
}

function publicHomeState(): HomeState {
  return {
    ...homeState,
    point: homeState.point ? { ...homeState.point } : null
  };
}

function publicReturnHomeState(): ReturnHomeState {
  return { ...returnHomeState };
}

function publicPiStatus(deviceId?: string | null): {
  online: boolean;
  connectionCount: number;
  clients: PiClientState[];
  lastOutbound: { type: string; sentAt: string; data: unknown } | null;
} {
  const matchingClients = [...piClients.values()]
    .filter((client) => !deviceId || client.deviceId === deviceId || client.deviceId === null)
    .sort((a, b) => Date.parse(b.lastMessageAt ?? b.connectedAt) - Date.parse(a.lastMessageAt ?? a.connectedAt));
  return {
    online: matchingClients.length > 0,
    connectionCount: matchingClients.length,
    clients: matchingClients,
    lastOutbound: lastPiOutbound
  };
}

function updatePiClient(ws: WebSocket, type: string, patch: Partial<PiClientState> = {}): void {
  const current = piClients.get(ws);
  if (!current) return;
  piClients.set(ws, {
    ...current,
    ...patch,
    lastMessageType: type,
    lastMessageAt: new Date().toISOString()
  });
}

function broadcastState(): void {
  broadcast('usv.telemetry', publicState());
}

function broadcast(type: string, data: unknown): void {
  for (const client of clients) sendWs(client, type, data);
}

function broadcastPi(type: string, data: unknown): void {
  lastPiOutbound = { type, sentAt: new Date().toISOString(), data };
  for (const client of piClients.keys()) sendWs(client, type, data);
}

function sendWs(ws: WebSocket, type: string, data: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, timestamp: new Date().toISOString(), data }));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
}

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const headerText = body.subarray(cursor, headerEnd).toString('utf8');
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    let data = body.subarray(headerEnd + 4, next);
    if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) {
      data = data.subarray(0, data.length - 2);
    }
    const disposition = headerText.match(/content-disposition:[^\r\n]+/i)?.[0] ?? '';
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    if (name) {
      parts.push({
        name,
        filename: disposition.match(/filename="([^"]*)"/)?.[1] || undefined,
        contentType: headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim(),
        data
      });
    }
    cursor = next;
  }
  return parts;
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

function sendCsv(res: http.ServerResponse, filename: string, csv: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(`\uFEFF${csv}`);
}

function eventQueryFromUrl(url: URL) {
  return {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    level: url.searchParams.get('level'),
    category: url.searchParams.get('category'),
    type: url.searchParams.get('type'),
    q: url.searchParams.get('q'),
    limit: numberParam(url, 'limit'),
    cursor: numberParam(url, 'cursor')
  };
}

function telemetryQueryFromUrl(url: URL) {
  return {
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    limit: numberParam(url, 'limit'),
    cursor: numberParam(url, 'cursor')
  };
}

function numberParam(url: URL, name: string): number | null {
  const value = url.searchParams.get(name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
