import type { ManualControlInput } from './types.js';

export type MavlinkFrame = {
  sequence: number;
  systemId: number;
  componentId: number;
  messageId: number;
  payload: Buffer;
  raw: Buffer;
  version: 1 | 2;
};

const MAVLINK1_MAGIC = 0xfe;
const MAVLINK2_MAGIC = 0xfd;
const SERVER_SYSTEM_ID = 255;
const SERVER_COMPONENT_ID = 190;

const CRC_EXTRA = new Map<number, number>([
  [0, 50],
  [1, 124],
  [11, 89],
  [24, 24],
  [25, 23],
  [33, 104],
  [39, 254],
  [40, 230],
  [41, 28],
  [42, 28],
  [43, 132],
  [44, 221],
  [45, 232],
  [46, 11],
  [47, 153],
  [51, 196],
  [69, 243],
  [70, 124],
  [73, 38],
  [74, 20],
  [76, 152],
  [77, 143],
  [147, 154],
  [253, 83]
]);

let txSequence = 0;

const PX4_MAIN_MODES = {
  manual: 1,
  altctl: 2,
  posctl: 3,
  auto: 4,
  acro: 5,
  offboard: 6,
  stabilized: 7
} as const;

const PX4_AUTO_SUB_MODES = {
  ready: 1,
  takeoff: 2,
  hold: 3,
  mission: 4,
  rtl: 5,
  land: 6
} as const;

export type Px4ModeKey = 'manual' | 'hold' | 'mission' | 'rtl' | 'posctl' | 'stabilized';

export type CommandAck = {
  command: number;
  result: number;
  resultName: string;
};

export type ParsedGpsRaw = {
  gpsFixType: number;
  gpsFixLabel: string;
  gpsSatellites: number | null;
  gpsHdop: number | null;
  gpsVdop: number | null;
  gpsHorizontalAccuracy: number | null;
  gpsAltitude: number | null;
};

export type ParsedGps2Raw = ParsedGpsRaw & {
  gps2Lat: number | null;
  gps2Lng: number | null;
  gps2DgpsAgeMs: number | null;
  gps2DgpsChannels: number | null;
};

export type ParsedGpsRtk = {
  receiverId: number;
  health: number;
  rateHz: number;
  satellites: number;
  baselineCoordsType: number;
  baselineAMm: number;
  baselineBMm: number;
  baselineCMm: number;
  baselineLengthMm: number;
  accuracyMm: number;
  iarHypotheses: number;
  lastBaselineMs: number;
  gpsWeek: number;
  gpsTowMs: number;
};

export type ParsedCorrectionData = {
  length: number;
  flags?: number;
  targetSystem?: number;
  targetComponent?: number;
};

export function decodeFrames(input: Buffer): MavlinkFrame[] {
  const frames: MavlinkFrame[] = [];
  let offset = 0;

  while (offset < input.length) {
    const mavlink1At = input.indexOf(MAVLINK1_MAGIC, offset);
    const mavlink2At = input.indexOf(MAVLINK2_MAGIC, offset);
    const magicAt = [mavlink1At, mavlink2At].filter((value) => value >= 0).sort((a, b) => a - b)[0];
    if (magicAt === undefined) break;
    offset = magicAt;

    const magic = input[offset];
    if (magic === MAVLINK1_MAGIC) {
      if (input.length - offset < 8) break;
      const length = input[offset + 1];
      const frameLength = 6 + length + 2;
      if (input.length - offset < frameLength) break;
      const raw = input.subarray(offset, offset + frameLength);
      const payload = raw.subarray(6, 6 + length);
      const messageId = raw[5];
      const expected = raw.readUInt16LE(6 + length);
      if (validateChecksum(raw.subarray(1, 6 + length), messageId, expected)) {
        frames.push({
          sequence: raw[2],
          systemId: raw[3],
          componentId: raw[4],
          messageId,
          payload,
          raw,
          version: 1
        });
      }
      offset += frameLength;
      continue;
    }

    if (input.length - offset < 12) break;

    const length = input[offset + 1];
    const incompatFlags = input[offset + 2];
    const signatureLength = (incompatFlags & 0x01) === 0x01 ? 13 : 0;
    const frameLength = 10 + length + 2 + signatureLength;
    if (input.length - offset < frameLength) break;

    const raw = input.subarray(offset, offset + frameLength);
    const payload = raw.subarray(10, 10 + length);
    const messageId = raw[7] | (raw[8] << 8) | (raw[9] << 16);
    const expected = raw.readUInt16LE(10 + length);

    if (validateChecksum(raw.subarray(1, 10 + length), messageId, expected)) {
      frames.push({
        sequence: raw[4],
        systemId: raw[5],
        componentId: raw[6],
        messageId,
        payload,
        raw,
        version: 2
      });
    }

    offset += frameLength;
  }

  return frames;
}

export function buildManualControl(targetSystem: number, input: ManualControlInput): Buffer {
  const payload = Buffer.alloc(11);
  const throttle = clamp(input.throttle, -1, 1);
  const steering = clamp(input.steering, -1, 1);

  payload.writeInt16LE(Math.round(throttle * 1000), 0);
  payload.writeInt16LE(0, 2);
  payload.writeInt16LE(Math.round(throttle * 1000), 4);
  payload.writeInt16LE(Math.round(steering * 1000), 6);
  payload.writeUInt16LE(0, 8);
  payload.writeUInt8(targetSystem, 10);

  return buildFrame(69, payload);
}

export function buildRcChannelsOverride(targetSystem: number, targetComponent: number, input: ManualControlInput): Buffer {
  const payload = Buffer.alloc(18);
  const throttle = clamp(input.throttle, -1, 1);
  const steering = clamp(input.steering, -1, 1);
  const throttlePwm = normalizedToPwm(throttle);
  const steeringPwm = normalizedToPwm(steering);

  payload.writeUInt16LE(steeringPwm, 0);
  payload.writeUInt16LE(0, 2);
  payload.writeUInt16LE(throttlePwm, 4);
  payload.writeUInt16LE(0, 6);
  payload.writeUInt16LE(0, 8);
  payload.writeUInt16LE(0, 10);
  payload.writeUInt16LE(0, 12);
  payload.writeUInt16LE(0, 14);
  payload.writeUInt8(targetSystem, 16);
  payload.writeUInt8(targetComponent, 17);

  return buildFrame(70, payload);
}

export function buildArmDisarm(targetSystem: number, targetComponent: number, arm: boolean): Buffer {
  return buildCommandLong(targetSystem, targetComponent, 400, [arm ? 1 : 0, 0, 0, 0, 0, 0, 0]);
}

export function buildRebootAutopilot(targetSystem: number, targetComponent: number): Buffer {
  return buildCommandLong(targetSystem, targetComponent, 246, [1, 0, 0, 0, 0, 0, 0]);
}

export function buildSetHome(targetSystem: number, targetComponent: number, lat: number, lng: number, altitude: number = 0): Buffer {
  return buildCommandLong(targetSystem, targetComponent, 179, [0, 0, 0, 0, lat, lng, altitude]);
}

export function buildSetRelay(targetSystem: number, targetComponent: number, relay: number, enabled: boolean): Buffer {
  return buildCommandLong(targetSystem, targetComponent, 181, [relay, enabled ? 1 : 0, 0, 0, 0, 0, 0]);
}

export function buildEmergencyStop(targetSystem: number, targetComponent: number): Buffer[] {
  return [
    buildManualControl(targetSystem, { throttle: 0, steering: 0 }),
    buildArmDisarm(targetSystem, targetComponent, false)
  ];
}

export function buildSetMode(
  targetSystem: number,
  targetComponent: number,
  mode: Px4ModeKey,
  autopilot: number | null = null
): Buffer[] {
  if (autopilot === 3) return buildArduPilotSetMode(targetSystem, targetComponent, mode);

  const { mainMode, subMode, customMode } = px4ModePayload(mode);
  const baseMode = 1;

  const setModePayload = Buffer.alloc(6);
  setModePayload.writeUInt32LE(customMode, 0);
  setModePayload.writeUInt8(targetSystem, 4);
  setModePayload.writeUInt8(baseMode, 5);

  return [
    buildFrame(11, setModePayload),
    buildCommandLong(targetSystem, targetComponent, 176, [baseMode, mainMode, subMode, 0, 0, 0, 0])
  ];
}

export function parseHeartbeat(payload: Buffer) {
  if (payload.length < 9) return null;
  const customMode = payload.readUInt32LE(0);
  const type = payload.readUInt8(4);
  const autopilot = payload.readUInt8(5);
  const baseMode = payload.readUInt8(6);
  const systemStatus = payload.readUInt8(7);

  return {
    customMode,
    autopilot,
    baseMode,
    systemStatus,
    armed: (baseMode & 0x80) === 0x80,
    mode: modeName(customMode, baseMode, autopilot, type),
    vehicleType: type
  };
}

export function parseSysStatus(payload: Buffer) {
  if (payload.length < 31) return null;
  const voltageMv = payload.readUInt16LE(14);
  const batteryRemaining = payload.readInt8(30);
  return {
    voltage: voltageMv > 0 ? voltageMv / 1000 : null,
    batteryPercent: batteryRemaining >= 0 ? batteryRemaining : null
  };
}

export function parseGpsRawInt(payload: Buffer): ParsedGpsRaw | null {
  if (payload.length < 30) return null;
  const fixType = payload.readUInt8(28);
  const satellites = payload.readUInt8(29);
  const hdopRaw = payload.readUInt16LE(20);
  const vdopRaw = payload.readUInt16LE(22);
  const hAccRaw = payload.length >= 38 ? payload.readUInt32LE(34) : 0;
  const altRaw = payload.readInt32LE(16);

  return {
    gpsFixType: fixType,
    gpsFixLabel: gpsFixTypeLabel(fixType),
    gpsSatellites: satellites === 255 ? null : satellites,
    gpsHdop: hdopRaw === 65535 ? null : hdopRaw / 100,
    gpsVdop: vdopRaw === 65535 ? null : vdopRaw / 100,
    gpsHorizontalAccuracy: hAccRaw > 0 && hAccRaw !== 0xffffffff ? hAccRaw / 1000 : null,
    gpsAltitude: altRaw === 0x7fffffff ? null : altRaw / 1000
  };
}

export function parseGps2Raw(payload: Buffer): ParsedGps2Raw | null {
  if (payload.length < 35) return null;
  const latRaw = payload.readInt32LE(8);
  const lngRaw = payload.readInt32LE(12);
  const altRaw = payload.readInt32LE(16);
  const dgpsAgeRaw = payload.readUInt32LE(20);
  const fixType = payload.readUInt8(32);
  const satellites = payload.readUInt8(33);
  const dgpsChannels = payload.readUInt8(34);
  const hdopRaw = payload.readUInt16LE(24);
  const vdopRaw = payload.readUInt16LE(26);

  return {
    gpsFixType: fixType,
    gpsFixLabel: gpsFixTypeLabel(fixType),
    gpsSatellites: satellites === 255 ? null : satellites,
    gpsHdop: hdopRaw === 65535 ? null : hdopRaw / 100,
    gpsVdop: vdopRaw === 65535 ? null : vdopRaw / 100,
    gpsHorizontalAccuracy: null,
    gpsAltitude: altRaw === 0x7fffffff ? null : altRaw / 1000,
    gps2Lat: latRaw === 0 ? null : latRaw / 1e7,
    gps2Lng: lngRaw === 0 ? null : lngRaw / 1e7,
    gps2DgpsAgeMs: dgpsAgeRaw === 0xffffffff ? null : dgpsAgeRaw,
    gps2DgpsChannels: dgpsChannels === 255 ? null : dgpsChannels
  };
}

export function parseGpsRtk(payload: Buffer): ParsedGpsRtk | null {
  if (payload.length < 35) return null;
  const baselineAMm = payload.readInt32LE(8);
  const baselineBMm = payload.readInt32LE(12);
  const baselineCMm = payload.readInt32LE(16);
  return {
    lastBaselineMs: payload.readUInt32LE(0),
    gpsTowMs: payload.readUInt32LE(4),
    baselineAMm,
    baselineBMm,
    baselineCMm,
    baselineLengthMm: Math.round(Math.sqrt(baselineAMm ** 2 + baselineBMm ** 2 + baselineCMm ** 2)),
    accuracyMm: payload.readUInt32LE(20),
    iarHypotheses: payload.readInt32LE(24),
    gpsWeek: payload.readUInt16LE(28),
    receiverId: payload.readUInt8(30),
    health: payload.readUInt8(31),
    rateHz: payload.readUInt8(32),
    satellites: payload.readUInt8(33),
    baselineCoordsType: payload.readUInt8(34)
  };
}

export function parseRtcmData(payload: Buffer): ParsedCorrectionData | null {
  if (payload.length < 2) return null;
  return {
    flags: payload.readUInt8(0),
    length: payload.readUInt8(1)
  };
}

export function parseGpsInjectData(payload: Buffer): ParsedCorrectionData | null {
  if (payload.length < 3) return null;
  return {
    targetSystem: payload.readUInt8(0),
    targetComponent: payload.readUInt8(1),
    length: payload.readUInt8(2)
  };
}

export function parseGpsStatus(payload: Buffer) {
  if (payload.length < 101) return null;
  const satellitesVisible = payload.readUInt8(0);
  const snrs: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const snr = payload.readUInt8(81 + i);
    if (snr > 0) snrs.push(snr);
  }

  if (snrs.length === 0) {
    return {
      gpsSatellites: satellitesVisible === 255 ? null : satellitesVisible,
      gpsSignalAverage: null,
      gpsSignalBest: null
    };
  }

  return {
    gpsSatellites: satellitesVisible === 255 ? null : satellitesVisible,
    gpsSignalAverage: Number((snrs.reduce((sum, snr) => sum + snr, 0) / snrs.length).toFixed(1)),
    gpsSignalBest: Math.max(...snrs)
  };
}

export function parseGlobalPositionInt(payload: Buffer) {
  if (payload.length < 28) return null;
  const lat = payload.readInt32LE(4) / 1e7;
  const lng = payload.readInt32LE(8) / 1e7;
  const vx = payload.readInt16LE(20) / 100;
  const vy = payload.readInt16LE(22) / 100;
  const headingRaw = payload.readUInt16LE(26);
  const position = lat === 0 && lng === 0 ? {} : { lat, lng };

  return {
    ...position,
    speed: Math.sqrt(vx * vx + vy * vy),
    heading: headingRaw === 65535 ? null : headingRaw / 100
  };
}

export function parseVfrHud(payload: Buffer) {
  if (payload.length < 20) return null;
  return {
    speed: payload.readFloatLE(0),
    heading: payload.readInt16LE(12)
  };
}

export function parseBatteryStatus(payload: Buffer) {
  if (payload.length < 36) return null;
  const cells: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const mv = payload.readUInt16LE(10 + i * 2);
    if (mv > 0 && mv !== 65535) cells.push(mv);
  }
  const totalMv = cells.reduce((sum, mv) => sum + mv, 0);
  const remaining = payload.readInt8(35);

  return {
    voltage: totalMv > 0 ? totalMv / 1000 : null,
    batteryPercent: remaining >= 0 ? remaining : null
  };
}

export function parseStatusText(payload: Buffer) {
  if (payload.length < 51) return null;
  const severity = payload.readUInt8(0);
  const textBytes = payload.subarray(1, 51);
  const zero = textBytes.indexOf(0);
  const text = textBytes.subarray(0, zero === -1 ? textBytes.length : zero).toString('utf8');
  return { severity, text };
}

export function parseCommandAck(payload: Buffer): CommandAck | null {
  if (payload.length < 3) return null;
  const result = payload.readUInt8(2);
  return {
    command: payload.readUInt16LE(0),
    result,
    resultName: commandResultName(result)
  };
}

export function buildCommandLongGeneric(targetSystem: number, targetComponent: number, command: number, params: number[]): Buffer {
  return buildCommandLong(targetSystem, targetComponent, command, params);
}

function buildCommandLong(targetSystem: number, targetComponent: number, command: number, params: number[]): Buffer {
  const payload = Buffer.alloc(33);
  for (let i = 0; i < 7; i += 1) payload.writeFloatLE(params[i] ?? 0, i * 4);
  payload.writeUInt16LE(command, 28);
  payload.writeUInt8(targetSystem, 30);
  payload.writeUInt8(targetComponent, 31);
  payload.writeUInt8(0, 32);
  return buildFrame(76, payload);
}

export function buildFrame(messageId: number, payload: Buffer, systemId = SERVER_SYSTEM_ID, componentId = SERVER_COMPONENT_ID): Buffer {
  const frame = Buffer.alloc(10 + payload.length + 2);
  frame[0] = MAVLINK2_MAGIC;
  frame[1] = payload.length;
  frame[2] = 0;
  frame[3] = 0;
  frame[4] = txSequence++ % 256;
  frame[5] = systemId;
  frame[6] = componentId;
  frame[7] = messageId & 0xff;
  frame[8] = (messageId >> 8) & 0xff;
  frame[9] = (messageId >> 16) & 0xff;
  payload.copy(frame, 10);
  const checksum = calculateChecksum(frame.subarray(1, 10 + payload.length), CRC_EXTRA.get(messageId) ?? 0);
  frame.writeUInt16LE(checksum, 10 + payload.length);
  return frame;
}

function validateChecksum(dataWithoutMagic: Buffer, messageId: number, expected: number): boolean {
  const extra = CRC_EXTRA.get(messageId);
  if (extra === undefined) return true;
  return calculateChecksum(dataWithoutMagic, extra) === expected;
}

function calculateChecksum(bytes: Buffer, extra: number): number {
  let crc = 0xffff;
  for (const byte of bytes) crc = crcAccumulate(byte, crc);
  return crcAccumulate(extra, crc);
}

function crcAccumulate(byte: number, crc: number): number {
  let tmp = byte ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function normalizedToPwm(value: number): number {
  return Math.round(1500 + clamp(value, -1, 1) * 500);
}

function commandResultName(result: number): string {
  const names: Record<number, string> = {
    0: 'ACCEPTED',
    1: 'TEMPORARILY_REJECTED',
    2: 'DENIED',
    3: 'UNSUPPORTED',
    4: 'FAILED',
    5: 'IN_PROGRESS',
    6: 'CANCELLED',
    7: 'COMMAND_LONG_ONLY',
    8: 'COMMAND_INT_ONLY',
    9: 'COMMAND_UNSUPPORTED_MISSION_ITEM'
  };
  return names[result] ?? `RESULT-${result}`;
}

function gpsFixTypeLabel(fixType: number): string {
  const labels: Record<number, string> = {
    0: 'NO_GPS',
    1: 'NO_FIX',
    2: '2D',
    3: '3D',
    4: 'DGPS',
    5: 'RTK_FLOAT',
    6: 'RTK_FIXED',
    7: 'STATIC',
    8: 'PPP'
  };
  return labels[fixType] ?? `FIX-${fixType}`;
}

function buildArduPilotSetMode(targetSystem: number, targetComponent: number, mode: Px4ModeKey): Buffer[] {
  const customMode = ardupilotRoverMode(mode);
  const baseMode = 1;

  const setModePayload = Buffer.alloc(6);
  setModePayload.writeUInt32LE(customMode, 0);
  setModePayload.writeUInt8(targetSystem, 4);
  setModePayload.writeUInt8(baseMode, 5);

  return [
    buildFrame(11, setModePayload),
    buildCommandLong(targetSystem, targetComponent, 176, [baseMode, customMode, 0, 0, 0, 0, 0])
  ];
}

function ardupilotRoverMode(mode: Px4ModeKey): number {
  if (mode === 'manual') return 0;
  if (mode === 'hold') return 4;
  if (mode === 'mission') return 10;
  if (mode === 'rtl') return 11;
  if (mode === 'posctl') return 15;
  if (mode === 'stabilized') return 3;
  return 0;
}

function modeName(customMode: number, baseMode: number, autopilot: number, vehicleType: number): string {
  if (autopilot === 3) return ardupilotRoverModeName(customMode);
  return px4ModeName(customMode, baseMode);
}

function ardupilotRoverModeName(customMode: number): string {
  const modes: Record<number, string> = {
    0: 'MANUAL',
    1: 'ACRO',
    3: 'STEERING',
    4: 'HOLD',
    5: 'LOITER',
    6: 'FOLLOW',
    7: 'SIMPLE',
    10: 'AUTO',
    11: 'RTL',
    12: 'SMART_RTL',
    15: 'GUIDED',
    16: 'INITIALISING'
  };
  return modes[customMode] ?? `ARDU-${customMode}`;
}

function px4ModeName(customMode: number, baseMode: number): string {
  if ((baseMode & 0x80) === 0 && customMode === 0) return 'STANDBY';
  const mainMode = (customMode >> 16) & 0xff;
  const subMode = (customMode >> 24) & 0xff;
  const mainModes: Record<number, string> = {
    1: 'MANUAL',
    2: 'ALTCTL',
    3: 'POSCTL',
    4: 'AUTO',
    5: 'ACRO',
    6: 'OFFBOARD',
    7: 'STABILIZED',
    8: 'RATTITUDE'
  };
  const autoSubModes: Record<number, string> = {
    1: 'READY',
    2: 'TAKEOFF',
    3: 'LOITER',
    4: 'MISSION',
    5: 'RTL',
    6: 'LAND',
    7: 'RTGS',
    8: 'FOLLOW_TARGET',
    9: 'PRECLAND'
  };
  const main = mainModes[mainMode] ?? `MODE-${mainMode}`;
  if (main === 'AUTO') return `AUTO.${autoSubModes[subMode] ?? subMode}`;
  return main;
}

function px4ModePayload(mode: Px4ModeKey): { mainMode: number; subMode: number; customMode: number } {
  if (mode === 'manual') return makeMode(PX4_MAIN_MODES.manual, 0);
  if (mode === 'posctl') return makeMode(PX4_MAIN_MODES.posctl, 0);
  if (mode === 'stabilized') return makeMode(PX4_MAIN_MODES.stabilized, 0);
  if (mode === 'hold') return makeMode(PX4_MAIN_MODES.auto, PX4_AUTO_SUB_MODES.hold);
  if (mode === 'mission') return makeMode(PX4_MAIN_MODES.auto, PX4_AUTO_SUB_MODES.mission);
  if (mode === 'rtl') return makeMode(PX4_MAIN_MODES.auto, PX4_AUTO_SUB_MODES.rtl);
  return makeMode(PX4_MAIN_MODES.manual, 0);
}

function makeMode(mainMode: number, subMode: number): { mainMode: number; subMode: number; customMode: number } {
  return {
    mainMode,
    subMode,
    customMode: (mainMode << 16) | (subMode << 24)
  };
}

// ==================== 航线上传协议 (ArduPilot) ====================

export function buildMissionCount(targetSystem: number, targetComponent: number, count: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(count, 0);
  payload.writeUInt8(targetSystem, 2);
  payload.writeUInt8(targetComponent, 3);
  return buildFrame(44, payload);
}

export function buildMissionRequestList(targetSystem: number, targetComponent: number): Buffer {
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(3);
  payload.writeUInt8(targetSystem, 0);
  payload.writeUInt8(targetComponent, 1);
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 2);
  return buildFrame(43, payload);
}

export function buildMissionRequestInt(targetSystem: number, targetComponent: number, sequence: number): Buffer {
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(5);
  payload.writeUInt16LE(sequence, 0);
  payload.writeUInt8(targetSystem, 2);
  payload.writeUInt8(targetComponent, 3);
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 4);
  return buildFrame(51, payload);
}

export function buildMissionItemInt(
  targetSystem: number,
  targetComponent: number,
  sequence: number,
  lat: number,
  lng: number,
  altitude: number = 0,
  command: number = 16,
  frame: number = 6,
  holdTimeSeconds: number = 0
): Buffer {
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(38);
  payload.writeFloatLE(holdTimeSeconds, 0); // param1: hold time
  payload.writeFloatLE(0, 4);             // param2: acceptance radius (use vehicle default)
  payload.writeFloatLE(0, 8);             // param3: pass radius
  payload.writeFloatLE(0, 12);            // param4: yaw
  payload.writeInt32LE(Math.round(lat * 1e7), 16);  // x (lat)
  payload.writeInt32LE(Math.round(lng * 1e7), 20);  // y (lng)
  payload.writeFloatLE(altitude, 24);     // z (altitude)
  payload.writeUInt16LE(sequence, 28);     // seq
  payload.writeUInt16LE(command, 30);      // command (MAV_CMD_NAV_WAYPOINT)
  payload.writeUInt8(targetSystem, 32);
  payload.writeUInt8(targetComponent, 33);
  payload.writeUInt8(frame, 34);
  payload.writeUInt8(0, 35);              // current: false while uploading mission items
  payload.writeUInt8(1, 36);              // autocontinue
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 37);
  return buildFrame(73, payload);
}

export function buildMissionItem(
  targetSystem: number,
  targetComponent: number,
  sequence: number,
  lat: number,
  lng: number,
  altitude: number = 0,
  command: number = 16,
  holdTimeSeconds: number = 0
): Buffer {
  const MAV_FRAME_GLOBAL_RELATIVE_ALT = 3;
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(38);
  payload.writeFloatLE(holdTimeSeconds, 0); // param1: hold time
  payload.writeFloatLE(0, 4);             // param2: acceptance radius (use vehicle default)
  payload.writeFloatLE(0, 8);             // param3: pass radius
  payload.writeFloatLE(0, 12);            // param4: yaw
  payload.writeFloatLE(lat, 16);          // x (lat)
  payload.writeFloatLE(lng, 20);          // y (lng)
  payload.writeFloatLE(altitude, 24);     // z (altitude)
  payload.writeUInt16LE(sequence, 28);    // seq
  payload.writeUInt16LE(command, 30);     // command (MAV_CMD_NAV_WAYPOINT)
  payload.writeUInt8(targetSystem, 32);
  payload.writeUInt8(targetComponent, 33);
  payload.writeUInt8(MAV_FRAME_GLOBAL_RELATIVE_ALT, 34);
  payload.writeUInt8(0, 35);              // current: false while uploading mission items
  payload.writeUInt8(1, 36);              // autocontinue
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 37);
  return buildFrame(39, payload);
}

export function buildMissionDoJumpInt(
  targetSystem: number,
  targetComponent: number,
  sequence: number,
  targetSequence: number,
  repeat: number
): Buffer {
  const MAV_FRAME_MISSION = 2;
  const MAV_CMD_DO_JUMP = 177;
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(38);
  payload.writeFloatLE(targetSequence, 0); // param1: target waypoint seq
  payload.writeFloatLE(repeat, 4);         // param2: repeat count, -1 = infinite
  payload.writeFloatLE(0, 8);
  payload.writeFloatLE(0, 12);
  payload.writeInt32LE(0, 16);
  payload.writeInt32LE(0, 20);
  payload.writeFloatLE(0, 24);
  payload.writeUInt16LE(sequence, 28);
  payload.writeUInt16LE(MAV_CMD_DO_JUMP, 30);
  payload.writeUInt8(targetSystem, 32);
  payload.writeUInt8(targetComponent, 33);
  payload.writeUInt8(MAV_FRAME_MISSION, 34);
  payload.writeUInt8(0, 35);
  payload.writeUInt8(1, 36);
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 37);
  return buildFrame(73, payload);
}

export function buildMissionCommandInt(
  targetSystem: number,
  targetComponent: number,
  sequence: number,
  command: number,
  params: number[] = []
): Buffer {
  const MAV_FRAME_MISSION = 2;
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(38);
  payload.writeFloatLE(params[0] ?? 0, 0);
  payload.writeFloatLE(params[1] ?? 0, 4);
  payload.writeFloatLE(params[2] ?? 0, 8);
  payload.writeFloatLE(params[3] ?? 0, 12);
  payload.writeInt32LE(0, 16);
  payload.writeInt32LE(0, 20);
  payload.writeFloatLE(params[6] ?? 0, 24);
  payload.writeUInt16LE(sequence, 28);
  payload.writeUInt16LE(command, 30);
  payload.writeUInt8(targetSystem, 32);
  payload.writeUInt8(targetComponent, 33);
  payload.writeUInt8(MAV_FRAME_MISSION, 34);
  payload.writeUInt8(0, 35);
  payload.writeUInt8(1, 36);
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 37);
  return buildFrame(73, payload);
}

export function buildMissionDoJump(
  targetSystem: number,
  targetComponent: number,
  sequence: number,
  targetSequence: number,
  repeat: number
): Buffer {
  const MAV_FRAME_MISSION = 2;
  const MAV_CMD_DO_JUMP = 177;
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(38);
  payload.writeFloatLE(targetSequence, 0); // param1: target waypoint seq
  payload.writeFloatLE(repeat, 4);         // param2: repeat count, -1 = infinite
  payload.writeFloatLE(0, 8);
  payload.writeFloatLE(0, 12);
  payload.writeFloatLE(0, 16);
  payload.writeFloatLE(0, 20);
  payload.writeFloatLE(0, 24);
  payload.writeUInt16LE(sequence, 28);
  payload.writeUInt16LE(MAV_CMD_DO_JUMP, 30);
  payload.writeUInt8(targetSystem, 32);
  payload.writeUInt8(targetComponent, 33);
  payload.writeUInt8(MAV_FRAME_MISSION, 34);
  payload.writeUInt8(0, 35);
  payload.writeUInt8(1, 36);
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 37);
  return buildFrame(39, payload);
}

export function buildMissionClearAll(targetSystem: number, targetComponent: number): Buffer {
  const payload = Buffer.alloc(3);
  payload.writeUInt8(targetSystem, 0);
  payload.writeUInt8(targetComponent, 1);
  payload.writeUInt8(0, 2);  // mission_type (0 = mission)
  return buildFrame(45, payload);
}

export function buildMissionSetCurrent(targetSystem: number, targetComponent: number, sequence: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16LE(sequence, 0);
  payload.writeUInt8(targetSystem, 2);
  payload.writeUInt8(targetComponent, 3);
  return buildFrame(41, payload);
}

export function buildMissionAck(targetSystem: number, targetComponent: number, result = 0): Buffer {
  const MAV_MISSION_TYPE_MISSION = 0;
  const payload = Buffer.alloc(4);
  payload.writeUInt8(targetSystem, 0);
  payload.writeUInt8(targetComponent, 1);
  payload.writeUInt8(result, 2);
  payload.writeUInt8(MAV_MISSION_TYPE_MISSION, 3);
  return buildFrame(47, payload);
}

export function parseMissionCount(payload: Buffer): { count: number; missionType: number } | null {
  if (payload.length < 4) return null;
  return {
    count: payload.readUInt16LE(0),
    missionType: payload.length >= 5 ? payload.readUInt8(4) : 0
  };
}

export function parseMissionRequest(payload: Buffer): { sequence: number } | null {
  if (payload.length < 4) return null;
  return {
    sequence: payload.readUInt16LE(0)
  };
}

export type ParsedMissionItem = {
  seq: number;
  command: number;
  frame: number;
  current: number;
  autocontinue: number;
  missionType: number;
  param1: number;
  param2: number;
  lat: number;
  lng: number;
  altitude: number;
};

export function parseMissionItemInt(payload: Buffer): ParsedMissionItem | null {
  if (payload.length < 37) return null;
  return {
    seq: payload.readUInt16LE(28),
    command: payload.readUInt16LE(30),
    frame: payload.readUInt8(34),
    current: payload.readUInt8(35),
    autocontinue: payload.readUInt8(36),
    missionType: payload.length >= 38 ? payload.readUInt8(37) : 0,
    param1: payload.readFloatLE(0),
    param2: payload.readFloatLE(4),
    lat: payload.readInt32LE(16) / 1e7,
    lng: payload.readInt32LE(20) / 1e7,
    altitude: payload.readFloatLE(24)
  };
}

export function parseMissionItem(payload: Buffer): ParsedMissionItem | null {
  if (payload.length < 37) return null;
  return {
    seq: payload.readUInt16LE(28),
    command: payload.readUInt16LE(30),
    frame: payload.readUInt8(34),
    current: payload.readUInt8(35),
    autocontinue: payload.readUInt8(36),
    missionType: payload.length >= 38 ? payload.readUInt8(37) : 0,
    param1: payload.readFloatLE(0),
    param2: payload.readFloatLE(4),
    lat: payload.readFloatLE(16),
    lng: payload.readFloatLE(20),
    altitude: payload.readFloatLE(24)
  };
}

export function parseMissionAck(payload: Buffer): { type: number; result: number } | null {
  if (payload.length < 3) return null;
  return {
    type: payload.length >= 4 ? payload.readUInt8(3) : 0,
    result: payload.readUInt8(2)
  };
}

export function parseMissionCurrent(payload: Buffer): { seq: number } | null {
  if (payload.length < 2) return null;
  return {
    seq: payload.readUInt16LE(0)
  };
}

export function parseMissionItemReached(payload: Buffer): { seq: number } | null {
  if (payload.length < 2) return null;
  return {
    seq: payload.readUInt16LE(0)
  };
}
