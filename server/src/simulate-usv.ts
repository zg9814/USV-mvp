import dgram from 'node:dgram';
import {
  buildFrame,
  buildMissionAck,
  buildMissionRequestInt,
  decodeFrames,
  parseMissionItemInt
} from './mavlink.js';
import type { MavlinkFrame, ParsedMissionItem } from './mavlink.js';

const cloudHost = process.env.SIM_HOST ?? '127.0.0.1';
const cloudPort = Number(process.env.SIM_PORT ?? 14550);
const listenPort = Number(process.env.SIM_LISTEN_PORT ?? 0);
const systemId = Number(process.env.SIM_SYS_ID ?? 1);
const componentId = Number(process.env.SIM_COMP_ID ?? 1);
const lowVoltage = process.env.SIM_LOW_VOLTAGE === '1';

const socket = dgram.createSocket('udp4');

let lat = Number(process.env.SIM_LAT ?? 31.1852);
let lng = Number(process.env.SIM_LNG ?? 120.2796);
let altitude = Number(process.env.SIM_ALT ?? 0);
let heading = 90;
let voltage = Number(process.env.SIM_VOLTAGE ?? (lowVoltage ? 21.4 : 23.6));
let battery = Number(process.env.SIM_BATTERY ?? 92);
let armed = true;
let mode: 'MANUAL' | 'HOLD' | 'MISSION' | 'RTL' = 'MANUAL';
let home: { lat: number; lng: number; altitude: number } | null = null;
let missionItems: ParsedMissionItem[] = [];
let expectedMissionCount = 0;
let nextMissionRequestSeq = 0;
let activeMissionSeq = 0;
let lastReachedSeq = -1;
let missionStartedAt = 0;
let cloudRemote = { address: cloudHost, port: cloudPort };

socket.on('message', (packet, remote) => {
  cloudRemote = { address: remote.address, port: remote.port };
  for (const frame of decodeFrames(packet)) handleCloudFrame(frame);
});

socket.on('listening', () => {
  const address = socket.address();
  console.log([
    `Interactive simulated USV listening on udp://0.0.0.0:${address.port}`,
    `sending to udp://${cloudHost}:${cloudPort}`,
    `lowVoltage=${lowVoltage}`,
    `voltage=${voltage.toFixed(2)}`
  ].join(' '));
});

socket.bind(listenPort, '0.0.0.0');

setInterval(() => {
  updateMotion();
  send(heartbeat());
  send(globalPosition());
  send(sysStatus());
  send(gpsRawInt());
  send(vfrHud());
}, 1000);

function handleCloudFrame(frame: MavlinkFrame): void {
  switch (frame.messageId) {
    case 11:
      handleSetMode(frame.payload);
      break;
    case 41:
      activeMissionSeq = frame.payload.length >= 2 ? frame.payload.readUInt16LE(0) : 0;
      missionStartedAt = Date.now();
      lastReachedSeq = activeMissionSeq - 1;
      send(missionCurrent(activeMissionSeq));
      break;
    case 44:
      handleMissionCount(frame.payload);
      break;
    case 45:
      missionItems = [];
      expectedMissionCount = 0;
      nextMissionRequestSeq = 0;
      send(buildMissionAck(255, 190, 0));
      break;
    case 73:
      handleMissionItemInt(frame);
      break;
    case 76:
      handleCommandLong(frame.payload);
      break;
    default:
      break;
  }
}

function handleCommandLong(payload: Buffer): void {
  if (payload.length < 33) return;
  const command = payload.readUInt16LE(28);
  if (command === 179) {
    home = {
      lat: payload.readFloatLE(16),
      lng: payload.readFloatLE(20),
      altitude: payload.readFloatLE(24)
    };
    console.log(`SIM SET_HOME accepted lat=${home.lat.toFixed(7)} lng=${home.lng.toFixed(7)} alt=${home.altitude.toFixed(1)}`);
    send(commandAck(179, 0));
    return;
  }
  if (command === 176) {
    const customMode = Math.round(payload.readFloatLE(4));
    setModeFromArduPilotCustomMode(customMode);
    send(commandAck(176, 0));
    return;
  }
  if (command === 400) {
    armed = payload.readFloatLE(0) === 1;
    send(commandAck(400, 0));
    return;
  }
  if (command === 246) {
    send(commandAck(246, 0));
    return;
  }
  send(commandAck(command, 0));
}

function handleSetMode(payload: Buffer): void {
  if (payload.length < 6) return;
  const customMode = payload.readUInt32LE(0);
  setModeFromPx4CustomMode(customMode);
}

function handleMissionCount(payload: Buffer): void {
  if (payload.length < 2) return;
  expectedMissionCount = payload.readUInt16LE(0);
  missionItems = [];
  nextMissionRequestSeq = 0;
  console.log(`SIM mission upload count=${expectedMissionCount}`);
  if (expectedMissionCount > 0) requestMissionItem(0);
}

function handleMissionItemInt(frame: MavlinkFrame): void {
  const item = parseMissionItemInt(frame.payload);
  if (!item) return;
  missionItems[item.seq] = item;
  console.log(`SIM mission item seq=${item.seq} cmd=${item.command} lat=${item.lat.toFixed(7)} lng=${item.lng.toFixed(7)} p1=${item.param1.toFixed(1)}`);
  nextMissionRequestSeq = item.seq + 1;
  if (nextMissionRequestSeq < expectedMissionCount) {
    requestMissionItem(nextMissionRequestSeq);
    return;
  }
  send(buildMissionAck(255, 190, 0));
  console.log('SIM mission upload accepted');
}

function updateMotion(): void {
  if (mode === 'MISSION' && missionItems.length > 0) {
    const target = missionItems[activeMissionSeq];
    if (target) moveToward({ lat: target.lat, lng: target.lng }, 1.8);
    if (target && distanceMeters({ lat, lng }, target) <= 4 && lastReachedSeq < activeMissionSeq) {
      lastReachedSeq = activeMissionSeq;
      send(missionReached(activeMissionSeq));
      activeMissionSeq = Math.min(activeMissionSeq + 1, missionItems.length - 1);
      send(missionCurrent(activeMissionSeq));
    }
  }

  if (mode === 'RTL' && home) {
    moveToward(home, 2.4);
  }

  heading = (heading + 7) % 360;
  if (!lowVoltage) {
    voltage = Math.max(22.8, voltage - 0.005);
  }
  battery = Math.max(20, battery - 0.02);
}

function requestMissionItem(seq: number): void {
  send(buildMissionRequestInt(255, 190, seq));
}

function setModeFromArduPilotCustomMode(customMode: number): void {
  if (customMode === 4) mode = 'HOLD';
  else if (customMode === 10) {
    mode = 'MISSION';
    missionStartedAt = Date.now();
  } else if (customMode === 11) mode = 'RTL';
  else mode = 'MANUAL';
  console.log(`SIM mode=${mode}`);
}

function setModeFromPx4CustomMode(customMode: number): void {
  const main = (customMode >> 16) & 0xff;
  const sub = (customMode >> 24) & 0xff;
  if (main === 4 && sub === 3) mode = 'HOLD';
  else if (main === 4 && sub === 4) mode = 'MISSION';
  else if (main === 4 && sub === 5) mode = 'RTL';
  else mode = 'MANUAL';
  console.log(`SIM mode=${mode}`);
}

function send(frame: Buffer): void {
  socket.send(frame, cloudRemote.port, cloudRemote.address);
}

function commandAck(command: number, result: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.writeUInt16LE(command, 0);
  payload.writeUInt8(result, 2);
  payload.writeUInt8(0, 3);
  payload.writeUInt8(0, 4);
  payload.writeUInt8(0, 5);
  payload.writeUInt8(255, 6);
  payload.writeUInt8(190, 7);
  return buildFrame(77, payload, systemId, componentId);
}

function heartbeat(): Buffer {
  const payload = Buffer.alloc(9);
  payload.writeUInt32LE(arduPilotCustomMode(), 0);
  payload.writeUInt8(10, 4);
  payload.writeUInt8(3, 5);
  payload.writeUInt8(armed ? 0x80 | 0x40 | 0x10 | 0x01 : 0x40 | 0x10 | 0x01, 6);
  payload.writeUInt8(4, 7);
  payload.writeUInt8(3, 8);
  return buildFrame(0, payload, systemId, componentId);
}

function arduPilotCustomMode(): number {
  if (mode === 'HOLD') return 4;
  if (mode === 'MISSION') return 10;
  if (mode === 'RTL') return 11;
  return 0;
}

function globalPosition(): Buffer {
  const payload = Buffer.alloc(28);
  payload.writeUInt32LE(Date.now() % 4_294_967_295, 0);
  payload.writeInt32LE(Math.round(lat * 1e7), 4);
  payload.writeInt32LE(Math.round(lng * 1e7), 8);
  payload.writeInt32LE(Math.round(altitude * 1000), 12);
  payload.writeInt32LE(Math.round(altitude * 1000), 16);
  payload.writeInt16LE(90, 20);
  payload.writeInt16LE(60, 22);
  payload.writeInt16LE(0, 24);
  payload.writeUInt16LE(Math.round(heading * 100), 26);
  return buildFrame(33, payload, systemId, componentId);
}

function gpsRawInt(): Buffer {
  const payload = Buffer.alloc(30);
  payload.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 0);
  payload.writeUInt8(3, 28);
  payload.writeUInt8(18, 29);
  payload.writeUInt16LE(70, 20);
  payload.writeUInt16LE(90, 22);
  payload.writeInt32LE(Math.round(altitude * 1000), 16);
  return buildFrame(24, payload, systemId, componentId);
}

function sysStatus(): Buffer {
  const payload = Buffer.alloc(31);
  payload.writeUInt16LE(Math.round(voltage * 1000), 14);
  payload.writeInt16LE(0, 16);
  payload.writeInt8(Math.round(battery), 30);
  return buildFrame(1, payload, systemId, componentId);
}

function vfrHud(): Buffer {
  const payload = Buffer.alloc(20);
  payload.writeFloatLE(mode === 'HOLD' ? 0 : 1.2, 0);
  payload.writeFloatLE(mode === 'HOLD' ? 0 : 1.2, 4);
  payload.writeInt16LE(Math.round(heading), 8);
  payload.writeUInt16LE(0, 10);
  payload.writeFloatLE(altitude, 12);
  payload.writeFloatLE(0, 16);
  return buildFrame(74, payload, systemId, componentId);
}

function missionCurrent(seq: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16LE(seq, 0);
  return buildFrame(42, payload, systemId, componentId);
}

function missionReached(seq: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16LE(seq, 0);
  return buildFrame(46, payload, systemId, componentId);
}

function moveToward(target: { lat: number; lng: number }, metersPerTick: number): void {
  const distance = distanceMeters({ lat, lng }, target);
  if (distance <= metersPerTick || distance === 0) {
    lat = target.lat;
    lng = target.lng;
    return;
  }
  const ratio = metersPerTick / distance;
  lat += (target.lat - lat) * ratio;
  lng += (target.lng - lng) * ratio;
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
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
