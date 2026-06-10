#!/usr/bin/env node

const baseUrl = (process.env.USV_BASE_URL ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const throttle = clampNumber(process.env.USV_THROTTLE, 0.25, -1, 1);
const steering = clampNumber(process.env.USV_STEERING, 0, -1, 1);
const intervalMs = clampNumber(process.env.USV_INTERVAL_MS, 250, 100, 2000);
const durationMs = clampNumber(process.env.USV_DURATION_MS, 10000, 1000, 10 * 60 * 1000);
const continuous = process.env.USV_CONTINUOUS === '1';

let timer = null;
let stopping = false;
let sentCount = 0;

if (throttle <= 0) {
  fail('USV_THROTTLE must be positive for this forward test.');
}

console.log([
  `USV forward test target=${baseUrl}`,
  `throttle=${throttle.toFixed(2)}`,
  `steering=${steering.toFixed(2)}`,
  `interval=${intervalMs}ms`,
  continuous ? 'duration=continuous' : `duration=${durationMs}ms`
].join(' '));

await assertOnline();

process.once('SIGINT', () => void stopAndExit('SIGINT', 130));
process.once('SIGTERM', () => void stopAndExit('SIGTERM', 143));

timer = setInterval(() => {
  void sendManual(throttle, steering)
    .then(() => {
      sentCount += 1;
      if (sentCount % Math.max(1, Math.round(1000 / intervalMs)) === 0) {
        console.log(`forward sent count=${sentCount}`);
      }
    })
    .catch((error) => void stopAndExit(`send failed: ${error.message}`, 1));
}, intervalMs);

await sendManual(throttle, steering);
sentCount += 1;

if (!continuous) {
  setTimeout(() => void stopAndExit('duration elapsed', 0), durationMs);
}

async function assertOnline() {
  const response = await fetch(`${baseUrl}/api/state`);
  if (!response.ok) fail(`GET /api/state failed with HTTP ${response.status}`);
  const body = await response.json();
  const state = body?.data;
  if (!state?.online) fail('USV is offline; refusing to send forward control.');
  console.log([
    `state online=${state.online}`,
    `mode=${state.mode}`,
    `armed=${state.armed}`,
    `voltage=${state.voltage ?? '--'}`,
    `remoteKnown=${state.remoteKnown}`
  ].join(' '));
}

async function sendManual(nextThrottle, nextSteering) {
  const response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'manual',
      throttle: Number(nextThrottle.toFixed(2)),
      steering: Number(nextSteering.toFixed(2))
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.message || `HTTP ${response.status}`);
  }
}

async function sendStopBurst() {
  for (let index = 0; index < 5; index += 1) {
    try {
      await sendManual(0, 0);
    } catch (error) {
      console.warn(`stop ${index + 1}/5 failed: ${error.message}`);
    }
    await sleep(120);
  }
}

async function stopAndExit(reason, code) {
  if (stopping) return;
  stopping = true;
  if (timer !== null) clearInterval(timer);
  console.log(`stopping: ${reason}; sending neutral controls`);
  await sendStopBurst();
  process.exit(code);
}

function clampNumber(raw, fallback, min, max) {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
