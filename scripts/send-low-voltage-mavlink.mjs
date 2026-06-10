#!/usr/bin/env node

import dgram from 'node:dgram';
import { buildFrame } from '../server/dist/mavlink.js';

const host = process.env.SIM_HOST ?? '121.40.86.143';
const port = Number(process.env.SIM_PORT ?? 14550);
const systemId = Number(process.env.SIM_SYS_ID ?? 1);
const componentId = Number(process.env.SIM_COMP_ID ?? 1);
const voltage = Number(process.env.SIM_VOLTAGE ?? 21.8);
const current = Number(process.env.SIM_CURRENT ?? 0);
const battery = Number(process.env.SIM_BATTERY ?? 73);
const lat = Number(process.env.SIM_LAT ?? 31.2895);
const lng = Number(process.env.SIM_LNG ?? 121.0421);
const altitude = Number(process.env.SIM_ALT ?? 0);
const satellites = Number(process.env.SIM_SATS ?? 28);
const fixType = Number(process.env.SIM_FIX_TYPE ?? 3);
const mode = String(process.env.SIM_MODE ?? 'MANUAL').toUpperCase();
const armed = process.env.SIM_ARMED !== '0';
const intervalMs = Number(process.env.SIM_INTERVAL_MS ?? 1000);

const socket = dgram.createSocket('udp4');
let sent = 0;

console.log([
  `Sending simulated MAVLink to udp://${host}:${port}`,
  `sys=${systemId}/${componentId}`,
  `voltage=${voltage.toFixed(2)}V`,
  `current=${current.toFixed(2)}A`,
  `battery=${battery}%`,
  `fixType=${fixType}`,
  `sats=${satellites}`,
  `mode=${mode}`,
  `armed=${armed}`,
  `interval=${intervalMs}ms`
].join(' '));

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

sendPacketSet();
const timer = setInterval(sendPacketSet, intervalMs);

function sendPacketSet() {
  const frames = [
    heartbeat(),
    sysStatus(),
    batteryStatus(),
    gpsRawInt(),
    gpsStatus(),
    globalPosition(),
    attitude(),
    vfrHud(),
    missionCurrent()
  ];

  for (const frame of frames) {
    socket.send(frame, port, host);
  }

  sent += 1;
  if (sent % 5 === 0) {
    console.log(`sent sets=${sent} voltage=${voltage.toFixed(2)}V`);
  }
}

function heartbeat() {
  const MAV_TYPE_SURFACE_BOAT = 11;
  const MAV_AUTOPILOT_ARDUPILOTMEGA = 3;
  const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1;
  const MAV_MODE_FLAG_SAFETY_ARMED = 128;
  const MAV_STATE_ACTIVE = 4;
  const customMode = ardupilotCustomMode(mode);
  const baseMode = MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (armed ? MAV_MODE_FLAG_SAFETY_ARMED : 0);
  const payload = Buffer.alloc(9);
  payload.writeUInt32LE(customMode, 0);
  payload.writeUInt8(MAV_TYPE_SURFACE_BOAT, 4);
  payload.writeUInt8(MAV_AUTOPILOT_ARDUPILOTMEGA, 5);
  payload.writeUInt8(baseMode, 6);
  payload.writeUInt8(MAV_STATE_ACTIVE, 7);
  payload.writeUInt8(3, 8); // MAVLink version
  return buildFrame(0, payload, systemId, componentId);
}

function sysStatus() {
  const payload = Buffer.alloc(31);
  payload.writeUInt16LE(Math.max(0, Math.round(voltage * 1000)), 14);
  payload.writeInt16LE(Math.round(current * 100), 16);
  payload.writeInt8(Math.round(battery), 30);
  return buildFrame(1, payload, systemId, componentId);
}

function batteryStatus() {
  const payload = Buffer.alloc(36);
  payload.writeInt32LE(0, 0);
  for (let index = 0; index < 10; index += 1) {
    payload.writeUInt16LE(index === 0 ? Math.round(voltage * 1000) : 0xFFFF, 10 + index * 2);
  }
  payload.writeInt8(Math.round(battery), 35);
  return buildFrame(147, payload, systemId, componentId);
}

function gpsRawInt() {
  const payload = Buffer.alloc(30);
  payload.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 0);
  payload.writeInt32LE(Math.round(lat * 1e7), 8);
  payload.writeInt32LE(Math.round(lng * 1e7), 12);
  payload.writeInt32LE(Math.round(altitude * 1000), 16);
  payload.writeUInt16LE(60, 20);
  payload.writeUInt16LE(90, 22);
  payload.writeUInt16LE(0, 24);
  payload.writeUInt16LE(0, 26);
  payload.writeUInt8(fixType, 28);
  payload.writeUInt8(satellites, 29);
  return buildFrame(24, payload, systemId, componentId);
}

function gpsStatus() {
  const payload = Buffer.alloc(101);
  payload.writeUInt8(Math.max(0, Math.min(20, satellites)), 0);
  for (let index = 0; index < 20; index += 1) {
    payload.writeUInt8(index < satellites ? 1 : 0, 1 + index);
    payload.writeUInt8(index < satellites ? 65 : 0, 61 + index);
  }
  return buildFrame(25, payload, systemId, componentId);
}

function globalPosition() {
  const payload = Buffer.alloc(28);
  payload.writeUInt32LE(Date.now() % 4_294_967_295, 0);
  payload.writeInt32LE(Math.round(lat * 1e7), 4);
  payload.writeInt32LE(Math.round(lng * 1e7), 8);
  payload.writeInt32LE(Math.round(altitude * 1000), 12);
  payload.writeInt32LE(Math.round(altitude * 1000), 16);
  payload.writeInt16LE(0, 20);
  payload.writeInt16LE(0, 22);
  payload.writeInt16LE(0, 24);
  payload.writeUInt16LE(0, 26);
  return buildFrame(33, payload, systemId, componentId);
}

function attitude() {
  const payload = Buffer.alloc(28);
  payload.writeUInt32LE(Date.now() % 4_294_967_295, 0);
  payload.writeFloatLE(0, 4);
  payload.writeFloatLE(0, 8);
  payload.writeFloatLE(0, 12);
  payload.writeFloatLE(0, 16);
  payload.writeFloatLE(0, 20);
  payload.writeFloatLE(0, 24);
  return buildFrame(30, payload, systemId, componentId);
}

function vfrHud() {
  const payload = Buffer.alloc(20);
  payload.writeFloatLE(0, 0);
  payload.writeFloatLE(0, 4);
  payload.writeInt16LE(0, 8);
  payload.writeUInt16LE(0, 10);
  payload.writeFloatLE(altitude, 12);
  payload.writeFloatLE(0, 16);
  return buildFrame(74, payload, systemId, componentId);
}

function missionCurrent() {
  const payload = Buffer.alloc(2);
  payload.writeUInt16LE(0, 0);
  return buildFrame(42, payload, systemId, componentId);
}

function ardupilotCustomMode(name) {
  const modes = {
    MANUAL: 0,
    ACRO: 1,
    STEERING: 3,
    HOLD: 4,
    LOITER: 5,
    FOLLOW: 6,
    SIMPLE: 7,
    AUTO: 10,
    RTL: 11,
    SMART_RTL: 12,
    GUIDED: 15,
    INITIALISING: 16
  };
  return modes[name] ?? modes.MANUAL;
}

function stop(signal) {
  clearInterval(timer);
  console.log(`stopping ${signal}`);
  socket.close();
}
