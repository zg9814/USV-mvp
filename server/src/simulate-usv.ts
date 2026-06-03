import dgram from 'node:dgram';
import { buildFrame } from './mavlink.js';

const host = process.env.SIM_HOST ?? '127.0.0.1';
const port = Number(process.env.SIM_PORT ?? 14550);
const systemId = Number(process.env.SIM_SYS_ID ?? 1);
const componentId = Number(process.env.SIM_COMP_ID ?? 1);
const socket = dgram.createSocket('udp4');

let lat = 31.1852;
let lng = 120.2796;
let heading = 90;
let battery = 92;

setInterval(() => {
  lat += 0.000012;
  lng += 0.000018;
  heading = (heading + 3) % 360;
  battery = Math.max(45, battery - 0.03);

  send(heartbeat());
  send(globalPosition());
  send(sysStatus());
}, 1000);

console.log(`Simulated USV sending MAVLink2 to udp://${host}:${port}`);

function send(frame: Buffer): void {
  socket.send(frame, port, host);
}

function heartbeat(): Buffer {
  const payload = Buffer.alloc(9);
  const mainModeManual = 1 << 16;
  payload.writeUInt32LE(mainModeManual, 0);
  payload.writeUInt8(10, 4);
  payload.writeUInt8(12, 5);
  payload.writeUInt8(0x80, 6);
  payload.writeUInt8(4, 7);
  payload.writeUInt8(3, 8);
  return buildFrame(0, payload, systemId, componentId);
}

function globalPosition(): Buffer {
  const payload = Buffer.alloc(28);
  payload.writeUInt32LE(Date.now() % 4_294_967_295, 0);
  payload.writeInt32LE(Math.round(lat * 1e7), 4);
  payload.writeInt32LE(Math.round(lng * 1e7), 8);
  payload.writeInt32LE(0, 12);
  payload.writeInt32LE(0, 16);
  payload.writeInt16LE(110, 20);
  payload.writeInt16LE(75, 22);
  payload.writeInt16LE(0, 24);
  payload.writeUInt16LE(Math.round(heading * 100), 26);
  return buildFrame(33, payload, systemId, componentId);
}

function sysStatus(): Buffer {
  const payload = Buffer.alloc(31);
  payload.writeUInt16LE(15800, 14);
  payload.writeInt8(Math.round(battery), 30);
  return buildFrame(1, payload, systemId, componentId);
}
