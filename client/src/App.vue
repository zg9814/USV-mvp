<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

type UsvState = {
  deviceId: string;
  systemId: number;
  componentId: number;
  online: boolean;
  armed: boolean;
  mode: string;
  customMode: number | null;
  baseMode: number | null;
  autopilot: number | null;
  vehicleType: number | null;
  systemStatus: number | null;
  lat: number | null;
  lng: number | null;
  gpsFixType: number | null;
  gpsFixLabel: string;
  gpsSatellites: number | null;
  gpsHdop: number | null;
  gpsVdop: number | null;
  gpsHorizontalAccuracy: number | null;
  gpsAltitude: number | null;
  gpsSignalAverage: number | null;
  gpsSignalBest: number | null;
  speed: number | null;
  heading: number | null;
  voltage: number | null;
  batteryPercent: number | null;
  lastSeen: string | null;
  remoteKnown: boolean;
  udpPort: number;
};

type TrackPoint = {
  lat: number;
  lng: number;
  recordedAt: number;
};

type Waypoint = {
  lat: number;
  lng: number;
  order: number;
};

type MapPoint = {
  lat: number;
  lng: number;
};

type MissionState = {
  status: 'idle' | 'uploading' | 'ready' | 'active' | 'paused' | 'completed';
  waypoints: Waypoint[];
  currentWaypoint: number;
  totalWaypoints: number;
};

type HomeState = {
  point: { lat: number; lng: number; altitude: number | null } | null;
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

type EventLogRow = {
  id: number;
  occurred_at: string;
  level: string;
  category: string;
  type: string;
  mode: string | null;
  armed: number | null;
  command: number | null;
  result: string | null;
  message: string;
  details_json: string | null;
  raw_hex: string | null;
};

type TelemetrySampleRow = {
  id: number;
  occurred_at: string;
  mode: string | null;
  armed: number | null;
  voltage: number | null;
  current: number | null;
  battery_percent: number | null;
  gps_fix_label: string | null;
  gps_satellites: number | null;
  gps_hdop: number | null;
  lat: number | null;
  lng: number | null;
  speed: number | null;
  heading: number | null;
};

declare global {
  interface Window {
    T?: any;
  }
}

const TIANDITU_KEY = '2a260b5417d4aef7010aae54dbd8ae49';
const TRACK_WINDOW_MS = 60_000;
const JOYSTICK_MAX_INPUT = 0.85;
const JOYSTICK_DEADZONE = 0.05;

const state = reactive<UsvState>({
  deviceId: 'USV-UNKNOWN',
  systemId: 0,
  componentId: 0,
  online: false,
  armed: false,
  mode: 'UNKNOWN',
  customMode: null,
  baseMode: null,
  autopilot: null,
  vehicleType: null,
  systemStatus: null,
  lat: null,
  lng: null,
  gpsFixType: null,
  gpsFixLabel: 'UNKNOWN',
  gpsSatellites: null,
  gpsHdop: null,
  gpsVdop: null,
  gpsHorizontalAccuracy: null,
  gpsAltitude: null,
  gpsSignalAverage: null,
  gpsSignalBest: null,
  speed: null,
  heading: null,
  voltage: null,
  batteryPercent: null,
  lastSeen: null,
  remoteKnown: false,
  udpPort: 14550
});

const wsConnected = ref(false);
const statusText = ref('等待船端心跳');
const mapStatusText = ref('地图加载中');
const throttle = ref(0);
const steering = ref(0);
const joystick = reactive({
  active: false,
  knobX: 0,
  knobY: 0,
  pointerId: null as number | null
});
const pressed = reactive(new Set<string>());
const track = ref<TrackPoint[]>([]);
const waypoints = ref<Waypoint[]>([]);
const planningEnabled = ref(false);
const mapLayerMode = ref<'vector' | 'satellite'>('vector');
const mapDisplayScale = ref(1);
const mapDisplayScales = [1, 1.5, 2];
const missionLoopCount = ref(1);
const missionActiveLoopCount = ref(1);
const missionCurrentLoop = ref(1);
const lastMissionSeq = ref<number | null>(null);
const MISSION_LOOP_MIN = 1;
const MISSION_LOOP_MAX = 10;
const mission = reactive<MissionState>({
  status: 'idle',
  waypoints: [],
  currentWaypoint: 0,
  totalWaypoints: 0
});
const home = reactive<HomeState>({
  point: null,
  syncStatus: 'unset',
  lastSyncAt: null,
  lastAckAt: null,
  lastResult: null,
  lastError: null
});
const returnHome = reactive<ReturnHomeState>({
  active: false,
  reason: null,
  startedAt: null,
  completedAt: null,
  lastDistanceMeters: null
});
const shipOverlay = reactive({
  visible: false,
  left: 0,
  top: 0,
  heading: 0,
  online: false
});
const displayShipPoint = ref<MapPoint | null>(null);
const displayTrack = ref<MapPoint[]>([]);
const activeView = ref<'console' | 'logs'>('console');
const homePickingEnabled = ref(false);
const lowVoltageMuted = ref(false);
const logFilters = reactive({
  from: toLocalDateInput(new Date(Date.now() - 60 * 60 * 1000)),
  to: toLocalDateInput(new Date()),
  level: '',
  category: '',
  type: ''
});
const eventRows = ref<EventLogRow[]>([]);
const telemetryRows = ref<TelemetrySampleRow[]>([]);
const expandedEventId = ref<number | null>(null);
const logsLoading = ref(false);
const logsError = ref('');

let ws: WebSocket | null = null;
let controlTimer: number | null = null;
let reconnectTimer: number | null = null;
let mapContainer: HTMLDivElement | null = null;
let map: any = null;
let trackLine: any = null;
let routeLine: any = null;
let homeMarker: any = null;
let waypointMarkers: any[] = [];
let hasCenteredMap = false;
let satelliteLayer: any = null;
let satelliteLabelLayer: any = null;
let tiandituLoadPromise: Promise<any> | null = null;
let mapInitPromise: Promise<void> | null = null;
let mapPointerStart: { x: number; y: number } | null = null;
let suppressNextMapClick = false;
let mapImageObserver: MutationObserver | null = null;

const voltageLabel = computed(() => state.voltage == null ? '--' : `${state.voltage.toFixed(2)} V`);
const speedLabel = computed(() => state.speed == null ? '--' : `${state.speed.toFixed(2)} m/s`);
const headingLabel = computed(() => state.heading == null ? '--' : `${Math.round(state.heading)} deg`);
const batteryLabel = computed(() => state.batteryPercent == null ? '--' : `${state.batteryPercent}%`);
const lastSeenLabel = computed(() => state.lastSeen ? new Date(state.lastSeen).toLocaleTimeString() : '--');
const gpsSatellitesLabel = computed(() => state.gpsSatellites == null ? '--' : `${state.gpsSatellites}`);
const gpsHdopLabel = computed(() => state.gpsHdop == null ? '--' : state.gpsHdop.toFixed(2));
const gpsAccuracyLabel = computed(() => state.gpsHorizontalAccuracy == null ? '--' : `${state.gpsHorizontalAccuracy.toFixed(2)} m`);
const gpsAltitudeLabel = computed(() => state.gpsAltitude == null ? '--' : `${state.gpsAltitude.toFixed(1)} m`);
const gpsSignalLabel = computed(() => {
  if (state.gpsSignalAverage == null && state.gpsSignalBest == null) return '--';
  if (state.gpsSignalAverage == null) return `max ${state.gpsSignalBest}`;
  if (state.gpsSignalBest == null) return `avg ${state.gpsSignalAverage}`;
  return `avg ${state.gpsSignalAverage} / max ${state.gpsSignalBest}`;
});
const coordinateModeLabel = computed(() => 'GPS/WGS-84 (天地图)');
const displayLngLabel = computed(() => displayShipPoint.value ? displayShipPoint.value.lng.toFixed(7) : '--');
const displayLatLabel = computed(() => displayShipPoint.value ? displayShipPoint.value.lat.toFixed(7) : '--');
const routeLengthMeters = computed(() => calculateRouteLength(waypoints.value));
const routeLengthLabel = computed(() => formatDistance(routeLengthMeters.value));
const missionUploadItemCount = computed(() => waypoints.value.length === 0 ? 0 : waypoints.value.length + 1 + (missionLoopCount.value > 1 ? 1 : 0));
const homeLabel = computed(() => home.point ? `${home.point.lng.toFixed(7)}, ${home.point.lat.toFixed(7)}` : '未设置');
const homeStatusLabel = computed(() => {
  const labels: Record<HomeState['syncStatus'], string> = {
    unset: '未设置',
    pending: '同步中',
    accepted: '已同步',
    rejected: '已拒绝',
    failed: '同步失败'
  };
  return labels[home.syncStatus];
});
const lowVoltageActive = computed(() => state.voltage !== null && state.voltage < 22);
const showLowVoltageAlarm = computed(() => lowVoltageActive.value && !lowVoltageMuted.value);
const missionLoopProgressLabel = computed(() => {
  if (mission.status !== 'active' && mission.status !== 'paused') return '';
  return `任务进行中 ${missionCurrentLoop.value}/${missionActiveLoopCount.value}`;
});
const missionStatusLabel = computed(() => {
  const labels: Record<string, string> = { idle: '空闲', uploading: '写入中', ready: '已写入', active: '执行中', paused: '已暂停', completed: '已完成' };
  return labels[mission.status] || mission.status;
});
const modes = [
  { key: 'manual', label: '手动' },
  { key: 'hold', label: '保持' },
  { key: 'rtl', label: '返航' },
  { key: 'posctl', label: '位置' },
  { key: 'stabilized', label: '增稳' }
];

const controlModes = computed(() => modes.filter((mode) => mode.key !== 'rtl'));

watch(track, updateMapOverlays, { deep: true });
watch(waypoints, updateRouteOverlays, { deep: true });
watch(() => home.point, updateHomeOverlay, { deep: true });
watch(() => [state.lat, state.lng, state.heading, state.online], updateMapOverlays);
watch(() => state.voltage, (voltage) => {
  if (voltage !== null && voltage >= 22) lowVoltageMuted.value = false;
});

onMounted(() => {
  connectWs();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', zeroControl);
  document.addEventListener('pointerdown', onDocumentMapPointerDown, true);
  document.addEventListener('pointermove', onDocumentMapPointerMove, true);
  document.addEventListener('pointerup', onDocumentMapPointerUp, true);
  document.addEventListener('pointercancel', onDocumentMapPointerCancel, true);
  document.addEventListener('mousedown', onDocumentMapPointerDown, true);
  document.addEventListener('mousemove', onDocumentMapPointerMove, true);
  document.addEventListener('mouseup', onDocumentMapPointerUp, true);
  initializeMap();
  loadHome();
  controlTimer = window.setInterval(() => {
    pruneTrack();
    updateKeyboardControl();
    updateShipOverlayPosition();
    if (Math.abs(throttle.value) > 0 || Math.abs(steering.value) > 0) {
      sendManual();
    }
  }, 80);
});

onBeforeUnmount(() => {
  ws?.close();
  if (controlTimer) window.clearInterval(controlTimer);
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', zeroControl);
  document.removeEventListener('pointerdown', onDocumentMapPointerDown, true);
  document.removeEventListener('pointermove', onDocumentMapPointerMove, true);
  document.removeEventListener('pointerup', onDocumentMapPointerUp, true);
  document.removeEventListener('pointercancel', onDocumentMapPointerCancel, true);
  document.removeEventListener('mousedown', onDocumentMapPointerDown, true);
  document.removeEventListener('mousemove', onDocumentMapPointerMove, true);
  document.removeEventListener('mouseup', onDocumentMapPointerUp, true);
  mapContainer?.removeEventListener('pointerdown', onMapPointerDown, true);
  mapContainer?.removeEventListener('pointermove', onMapPointerMove, true);
  mapContainer?.removeEventListener('pointerup', onMapPointerUp, true);
  mapContainer?.removeEventListener('pointercancel', onMapPointerCancel, true);
  mapContainer?.removeEventListener('mousedown', onMapPointerDown, true);
  mapContainer?.removeEventListener('mousemove', onMapPointerMove, true);
  mapContainer?.removeEventListener('mouseup', onMapPointerUp, true);
  mapContainer?.removeEventListener('dragstart', onMapDragStart);
  mapImageObserver?.disconnect();
  resetJoystick();
});

function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.addEventListener('open', () => {
    wsConnected.value = true;
    statusText.value = 'WebSocket 已连接';
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'usv.telemetry') {
      Object.assign(state, message.data);
      if (message.data.mission) Object.assign(mission, message.data.mission);
      if (state.lat != null && state.lng != null) {
        const now = Date.now();
        const last = track.value.at(-1);
        if (!last || Math.abs(last.lat - state.lat) > 0.000001 || Math.abs(last.lng - state.lng) > 0.000001) {
          track.value = [...track.value, { lat: state.lat, lng: state.lng, recordedAt: now }]
            .filter((point) => now - point.recordedAt <= TRACK_WINDOW_MS);
        } else {
          pruneTrack(now);
        }
      }
    }
    if (message.type === 'usv.statusText') {
      statusText.value = message.data.text;
    }
    if (message.type === 'control.sent') {
      if (message.data.action === 'rebootAutopilot') {
        statusText.value = '重启命令已发送，等待心跳恢复';
      } else if (message.data.action === 'rebootDisarmPending') {
        statusText.value = '已发送上锁命令，确认上锁后将重启飞控';
      } else {
        statusText.value = `已发送 ${message.data.action}`;
      }
    }
    if (message.type === 'error') {
      statusText.value = message.data.message || '控制命令发送失败';
    }
    if (message.type === 'mission.current') {
      updateMissionCurrent(message.data.seq);
    }
    if (message.type === 'mission.reached') {
      statusText.value = `到达航点 ${message.data.seq + 1}`;
    }
    if (message.type === 'mission.uploaded') {
      mission.status = message.data.success ? 'ready' : 'idle';
      if (!message.data.success) resetMissionLoopProgress();
      statusText.value = message.data.success ? '航点写入成功' : `航点写入失败：${message.data.result ?? '未收到飞控确认'}`;
    }
    if (message.type === 'mission.started') {
      mission.status = 'active';
      statusText.value = '任务已开始执行';
    }
    if (message.type === 'mission.paused') {
      mission.status = 'paused';
      statusText.value = '任务已暂停';
    }
    if (message.type === 'mission.resumed') {
      mission.status = 'active';
      statusText.value = '任务已继续';
    }
    if (message.type === 'mission.cleared') {
      mission.status = 'idle';
      mission.waypoints = [];
      mission.currentWaypoint = 0;
      mission.totalWaypoints = 0;
      resetMissionLoopProgress();
      statusText.value = '航线已清除';
    }
    if (message.type === 'mission.completed') {
      mission.status = 'completed';
      statusText.value = '任务已完成，已保持在返航点';
    }
    if (message.type === 'home.updated' || message.type === 'home.syncAck') {
      Object.assign(home, message.data);
      updateHomeOverlay();
      statusText.value = home.syncStatus === 'accepted'
        ? '返航点已同步到飞控'
        : home.lastError || statusText.value;
    }
    if (message.type === 'return.home') {
      Object.assign(returnHome, message.data);
      if (returnHome.active) statusText.value = '正在返航';
    }
  });

  ws.addEventListener('close', () => {
    wsConnected.value = false;
    statusText.value = 'WebSocket 断开，正在重连';
    reconnectTimer = window.setTimeout(connectWs, 1000);
  });
}

function send(type: string, data: unknown = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, data }));
  return true;
}

async function postJson<T = { ok: boolean; message?: string }>(url: string, data: unknown = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const result = await response.json() as T;
  if (!response.ok) {
    const message = typeof result === 'object' && result && 'message' in result ? String(result.message) : response.statusText;
    throw new Error(message);
  }
  return result;
}

async function loadHome() {
  try {
    const response = await fetch('/api/home');
    const result = await response.json() as { data?: HomeState };
    if (result.data) {
      Object.assign(home, result.data);
      updateHomeOverlay();
    }
  } catch (error) {
    console.warn(error);
  }
}

async function setHome(point: { lat: number; lng: number; altitude?: number | null }) {
  try {
    const result = await postJson<{ ok: boolean; message?: string; data?: HomeState }>('/api/home', point);
    if (result.data) Object.assign(home, result.data);
    updateHomeOverlay();
    statusText.value = result.message || '返航点同步请求已发送';
  } catch (error) {
    statusText.value = `返航点设置失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

function setHomeFromCurrent() {
  if (state.lat == null || state.lng == null) {
    statusText.value = '当前没有可用 GPS，无法设为返航点';
    return;
  }
  setHome({ lat: state.lat, lng: state.lng, altitude: state.gpsAltitude });
}

function toggleHomePicking() {
  homePickingEnabled.value = !homePickingEnabled.value;
  if (homePickingEnabled.value) planningEnabled.value = false;
}

function returnHomeNow() {
  send('control.returnHome');
}

function muteLowVoltageAlarm() {
  lowVoltageMuted.value = true;
}

async function loadLogs() {
  logsLoading.value = true;
  logsError.value = '';
  try {
    const [eventsResponse, telemetryResponse] = await Promise.all([
      fetch(`/api/logs/events?${logQueryParams()}`),
      fetch(`/api/logs/telemetry?${telemetryQueryParams()}`)
    ]);
    const events = await eventsResponse.json() as { data?: { items?: EventLogRow[] } };
    const telemetry = await telemetryResponse.json() as { data?: { items?: TelemetrySampleRow[] } };
    eventRows.value = events.data?.items ?? [];
    telemetryRows.value = telemetry.data?.items ?? [];
  } catch (error) {
    logsError.value = error instanceof Error ? error.message : 'Failed to load logs';
  } finally {
    logsLoading.value = false;
  }
}

function logQueryParams() {
  const params = new URLSearchParams();
  params.set('from', localInputToIso(logFilters.from));
  params.set('to', localInputToIso(logFilters.to));
  params.set('limit', '200');
  if (logFilters.level) params.set('level', logFilters.level);
  if (logFilters.category) params.set('category', logFilters.category);
  if (logFilters.type) params.set('type', logFilters.type);
  return params.toString();
}

function telemetryQueryParams() {
  const params = new URLSearchParams();
  params.set('from', localInputToIso(logFilters.from));
  params.set('to', localInputToIso(logFilters.to));
  params.set('limit', '200');
  return params.toString();
}

function exportLogs(kind: 'events' | 'telemetry') {
  const query = kind === 'events' ? logQueryParams() : telemetryQueryParams();
  window.location.href = `/api/logs/export.csv?kind=${kind}&${query}`;
}

function switchView(view: 'console' | 'logs') {
  activeView.value = view;
  if (view === 'logs' && eventRows.value.length === 0 && telemetryRows.value.length === 0) {
    loadLogs();
  }
}

function eventDetails(row: EventLogRow) {
  if (!row.details_json) return null;
  try {
    return JSON.parse(row.details_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function eventVoltage(row: EventLogRow) {
  const details = eventDetails(row);
  const value = details?.voltage;
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} V` : '--';
}

function eventGps(row: EventLogRow) {
  const details = eventDetails(row);
  const fix = typeof details?.gpsFixLabel === 'string' ? details.gpsFixLabel : '--';
  const sats = typeof details?.gpsSatellites === 'number' ? details.gpsSatellites : '--';
  return `${fix} / ${sats}`;
}

function formatLogTime(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
}

function formatNullable(value: unknown, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function toLocalDateInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function sendManual() {
  send('manual.control', {
    throttle: Number(throttle.value.toFixed(2)),
    steering: Number(steering.value.toFixed(2))
  });
}

function command(type: string) {
  send(type);
}

function rebootAutopilot() {
  const message = state.armed
    ? '当前已解锁，系统会先发送上锁命令，确认上锁后再重启飞控。重启期间 MAVLink 会短暂断开。确认继续？'
    : '重启飞控会导致 MAVLink 短暂断开，数秒后等待心跳恢复。确认重启？';
  if (!window.confirm(message)) return;
  if (send('control.reboot', { confirmed: true })) {
    statusText.value = state.armed ? '已发送上锁命令，确认上锁后将重启飞控' : '重启命令已发送，等待心跳恢复';
  }
}

async function uploadMission() {
  if (waypoints.value.length === 0) return;
  const loopCount = clamp(Math.round(missionLoopCount.value), MISSION_LOOP_MIN, MISSION_LOOP_MAX);
  missionLoopCount.value = loopCount;
  missionActiveLoopCount.value = loopCount;
  missionCurrentLoop.value = 1;
  lastMissionSeq.value = null;
  mission.status = 'uploading';
  mission.waypoints = waypoints.value;
  mission.currentWaypoint = 0;
  mission.totalWaypoints = missionUploadItemCount.value;
  try {
    const result = await postJson('/api/mission/upload', { waypoints: waypoints.value, loopCount });
    statusText.value = result.message || '航点写入请求已发送';
  } catch (error) {
    mission.status = 'idle';
    resetMissionLoopProgress();
    statusText.value = `航点写入失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

async function startMission() {
  try {
    const result = await postJson('/api/mission/start');
    mission.status = 'active';
    statusText.value = result.message || '任务已开始执行';
  } catch (error) {
    statusText.value = `开始执行失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

async function pauseMission() {
  try {
    const result = await postJson('/api/mission/pause');
    mission.status = 'paused';
    statusText.value = result.message || '任务已暂停';
  } catch (error) {
    statusText.value = `暂停任务失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

async function resumeMission() {
  try {
    const result = await postJson('/api/mission/resume');
    mission.status = 'active';
    statusText.value = result.message || '任务已继续';
  } catch (error) {
    statusText.value = `继续任务失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

async function clearMission() {
  try {
    const result = await postJson('/api/mission/clear');
    mission.status = 'idle';
    mission.waypoints = [];
    mission.currentWaypoint = 0;
    mission.totalWaypoints = 0;
    resetMissionLoopProgress();
    statusText.value = result.message || '航线已清除';
  } catch (error) {
    statusText.value = `清除任务失败：${error instanceof Error ? error.message : '未知错误'}`;
  }
}

function updateMissionCurrent(seq: number) {
  if (!Number.isFinite(seq)) return;
  if (lastMissionSeq.value != null && seq < lastMissionSeq.value && missionCurrentLoop.value < missionActiveLoopCount.value) {
    missionCurrentLoop.value += 1;
  }
  lastMissionSeq.value = seq;
  mission.currentWaypoint = seq;
}

function resetMissionLoopProgress() {
  missionActiveLoopCount.value = 1;
  missionCurrentLoop.value = 1;
  lastMissionSeq.value = null;
}

function setMode(mode: string) {
  send('control.setMode', { mode });
}

function zeroControl() {
  throttle.value = 0;
  steering.value = 0;
  pressed.clear();
  resetJoystick(false);
  sendManual();
}

function onKeyDown(event: KeyboardEvent) {
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.code)) {
    event.preventDefault();
    pressed.add(event.code);
    updateKeyboardControl();
  }
}

function onKeyUp(event: KeyboardEvent) {
  pressed.delete(event.code);
  updateKeyboardControl();
  if (pressed.size === 0) zeroControl();
}

function updateKeyboardControl() {
  let nextThrottle = 0;
  let nextSteering = 0;
  if (pressed.has('KeyW') || pressed.has('ArrowUp')) nextThrottle += 0.55;
  if (pressed.has('KeyS') || pressed.has('ArrowDown')) nextThrottle -= 0.35;
  if (pressed.has('KeyA') || pressed.has('ArrowLeft')) nextSteering -= 0.55;
  if (pressed.has('KeyD') || pressed.has('ArrowRight')) nextSteering += 0.55;
  if (pressed.size > 0) {
    throttle.value = nextThrottle;
    steering.value = nextSteering;
  }
}

function nudge(axis: 'throttle' | 'steering', value: number) {
  if (axis === 'throttle') throttle.value = value;
  if (axis === 'steering') steering.value = value;
  sendManual();
}

function onJoystickPointerDown(event: PointerEvent) {
  joystick.active = true;
  joystick.pointerId = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  updateJoystickFromPointer(event);
}

function onJoystickPointerMove(event: PointerEvent) {
  if (!joystick.active || joystick.pointerId !== event.pointerId) return;
  updateJoystickFromPointer(event);
}

function onJoystickPointerUp(event: PointerEvent) {
  if (joystick.pointerId !== event.pointerId) return;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  resetJoystick();
}

function updateJoystickFromPointer(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  const radius = rect.width / 2;
  const dx = event.clientX - (rect.left + radius);
  const dy = event.clientY - (rect.top + radius);
  const distance = Math.min(radius, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);
  const normalizedX = distance === 0 ? 0 : (Math.cos(angle) * distance) / radius;
  const normalizedY = distance === 0 ? 0 : (Math.sin(angle) * distance) / radius;

  joystick.knobX = normalizedX * radius;
  joystick.knobY = normalizedY * radius;
  steering.value = applyDeadzone(normalizedX) * JOYSTICK_MAX_INPUT;
  throttle.value = -applyDeadzone(normalizedY) * JOYSTICK_MAX_INPUT;
}

function resetJoystick(send = true) {
  joystick.active = false;
  joystick.pointerId = null;
  joystick.knobX = 0;
  joystick.knobY = 0;
  throttle.value = 0;
  steering.value = 0;
  if (send) sendManual();
}

function applyDeadzone(value: number) {
  if (Math.abs(value) < JOYSTICK_DEADZONE) return 0;
  return Number(value.toFixed(2));
}

function bindMap(el: HTMLDivElement | null) {
  if (mapContainer) {
    mapContainer.removeEventListener('pointerdown', onMapPointerDown, true);
    mapContainer.removeEventListener('pointermove', onMapPointerMove, true);
    mapContainer.removeEventListener('pointerup', onMapPointerUp, true);
    mapContainer.removeEventListener('pointercancel', onMapPointerCancel, true);
    mapContainer.removeEventListener('mousedown', onMapPointerDown, true);
    mapContainer.removeEventListener('mousemove', onMapPointerMove, true);
    mapContainer.removeEventListener('mouseup', onMapPointerUp, true);
  }
  mapContainer = el;
  mapContainer?.addEventListener('pointerdown', onMapPointerDown, true);
  mapContainer?.addEventListener('pointermove', onMapPointerMove, true);
  mapContainer?.addEventListener('pointerup', onMapPointerUp, true);
  mapContainer?.addEventListener('pointercancel', onMapPointerCancel, true);
  mapContainer?.addEventListener('mousedown', onMapPointerDown, true);
  mapContainer?.addEventListener('mousemove', onMapPointerMove, true);
  mapContainer?.addEventListener('mouseup', onMapPointerUp, true);
  mapContainer?.addEventListener('dragstart', onMapDragStart);
  initializeMap();
}

function loadTianditu() {
  if (window.T) return Promise.resolve(window.T);
  if (tiandituLoadPromise) return tiandituLoadPromise;

  tiandituLoadPromise = new Promise((resolve, reject) => {
    const script = (document.getElementById('tianditu-js-api') as HTMLScriptElement | null) ?? document.createElement('script');
    const onError = () => {
      tiandituLoadPromise = null;
      mapStatusText.value = '天地图脚本加载失败';
      reject(new Error('天地图加载失败'));
    };
    const onLoad = () => {
      if (window.T) {
        mapStatusText.value = '天地图已加载';
        resolve(window.T);
      } else {
        tiandituLoadPromise = null;
        mapStatusText.value = '天地图加载失败';
        reject(new Error('天地图加载失败'));
      }
    };

    script.id = 'tianditu-js-api';
    script.src = `https://api.tianditu.gov.cn/api?v=4.0&tk=${TIANDITU_KEY}`;
    script.async = true;
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    if (!script.parentElement) document.head.appendChild(script);
  });

  return tiandituLoadPromise;
}

async function initializeMap() {
  if (!mapContainer || map) return;
  if (mapInitPromise) return mapInitPromise;

  mapInitPromise = initializeMapOnce().finally(() => {
    mapInitPromise = null;
  });

  return mapInitPromise;
}

async function initializeMapOnce() {
  if (!mapContainer || map) return;

  try {
    await loadTianditu();
  } catch (error) {
    console.error(error);
    return;
  }

  if (!mapContainer || map) return;

  const T = window.T;
  mapContainer.replaceChildren();
  map = new T.Map(mapContainer);
  map.centerAndZoom(new T.LngLat(121.04708, 31.2792), 16);
  map.enableDrag?.();
  map.enableScrollWheelZoom?.();
  map.enableKeyboard?.();

  // 创建卫星图层（影像底图 + 影像注记）
  satelliteLayer = new T.TileLayer(`http://t0.tianditu.gov.cn/img_w/wmts?tk=${TIANDITU_KEY}&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=img&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`);
  satelliteLabelLayer = new T.TileLayer(`http://t0.tianditu.gov.cn/cia_w/wmts?tk=${TIANDITU_KEY}&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cia&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`);

  trackLine = new T.Polyline([], {
    color: '#0f766e',
    weight: 5,
    opacity: 0.95,
    lineStyle: 'solid'
  });
  map.addOverLay(trackLine);

  routeLine = new T.Polyline([], {
    color: '#2563eb',
    weight: 4,
    opacity: 0.95,
    lineStyle: 'dashed'
  });
  map.addOverLay(routeLine);

  bindMapMoveEvents();
  setupMapPointerBehavior();
  showDebugShipMarker();
  updateMapOverlays();
  updateRouteOverlays();
  updateHomeOverlay();
}

function setMapLayer(mode: 'vector' | 'satellite') {
  mapLayerMode.value = mode;
  updateMapLayers();
}

function setMapDisplayScale(scale: number) {
  mapDisplayScale.value = scale;
  updateRouteOverlays();
  updateMapOverlays();
}

function updateMapLayers() {
  if (!map || !satelliteLayer || !satelliteLabelLayer) return;

  if (mapLayerMode.value === 'satellite') {
    map.addOverLay(satelliteLayer);
    map.addOverLay(satelliteLabelLayer);
  } else {
    map.removeOverLay(satelliteLayer);
    map.removeOverLay(satelliteLabelLayer);
  }
}

function updateMapOverlays() {
  if (!map || state.lat == null || state.lng == null) return;

  const T = window.T;
  const position = new T.LngLat(state.lng, state.lat);
  displayShipPoint.value = { lng: state.lng, lat: state.lat };
  updateShipOverlayPosition();

  displayTrack.value = track.value.map((p) => ({ lng: p.lng, lat: p.lat }));
  trackLine?.setLngLats(displayTrack.value.map((p) => new T.LngLat(p.lng, p.lat)));

  if (!hasCenteredMap) {
    map.centerAndZoom(position, 17);
    hasCenteredMap = true;
    updateShipOverlayPosition();
  }
}

function updateShipOverlayPosition() {
  if (!map || !mapContainer || !displayShipPoint.value) {
    shipOverlay.visible = false;
    return;
  }

  const point = lngLatToContainerPoint(displayShipPoint.value.lng, displayShipPoint.value.lat);
  if (!point) {
    shipOverlay.visible = false;
    return;
  }

  const mapRect = mapContainer.getBoundingClientRect();
  const panelRect = mapContainer.parentElement?.getBoundingClientRect() ?? mapRect;
  shipOverlay.left = point.x + mapRect.left - panelRect.left;
  shipOverlay.top = point.y + mapRect.top - panelRect.top;
  shipOverlay.heading = normalizeHeading(state.heading);
  shipOverlay.online = state.online;
  shipOverlay.visible = true;
}

function lngLatToContainerPoint(lng: number, lat: number) {
  if (!map || !mapContainer) return null;

  const T = window.T;
  const lngLat = new T.LngLat(lng, lat);
  const apiPoint = map.lngLatToContainerPoint?.(lngLat)
    || map.lngLatToLayerPoint?.(lngLat)
    || map.lngLatToPixel?.(lngLat);
  const normalizedApiPoint = normalizeMapPoint(apiPoint);
  if (normalizedApiPoint) {
    return {
      x: normalizedApiPoint.x * mapDisplayScale.value,
      y: normalizedApiPoint.y * mapDisplayScale.value
    };
  }

  return lngLatToContainerPointByMercator(lng, lat);
}

function normalizeMapPoint(point: any) {
  if (!point) return null;
  const x = typeof point.x === 'number' ? point.x : typeof point.getX === 'function' ? point.getX() : Array.isArray(point) ? point[0] : null;
  const y = typeof point.y === 'number' ? point.y : typeof point.getY === 'function' ? point.getY() : Array.isArray(point) ? point[1] : null;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x, y };
}

function lngLatToContainerPointByMercator(lng: number, lat: number) {
  if (!map || !mapContainer) return null;

  const center = map.getCenter?.();
  const zoom = map.getZoom?.();
  if (!center || typeof zoom !== 'number') return null;

  const centerLng = center.lng ?? center.getLng?.();
  const centerLat = center.lat ?? center.getLat?.();
  if (typeof centerLng !== 'number' || typeof centerLat !== 'number') return null;

  const mapRect = mapContainer.getBoundingClientRect();
  const scale = 256 * 2 ** zoom;
  const centerWorld = lngLatToWorldPixel(centerLng, centerLat, scale);
  const pointWorld = lngLatToWorldPixel(lng, lat, scale);

  return {
    x: (mapRect.width / 2 + pointWorld.x - centerWorld.x) * mapDisplayScale.value,
    y: (mapRect.height / 2 + pointWorld.y - centerWorld.y) * mapDisplayScale.value
  };
}

function normalizeHeading(heading: number | null) {
  if (heading == null || !Number.isFinite(heading)) return 0;
  return ((heading % 360) + 360) % 360;
}

function showDebugShipMarker() {
  if (!map || state.lat != null || state.lng != null) return;
  shipOverlay.visible = false;
  shipOverlay.heading = 0;
  shipOverlay.online = false;
}

function updateRouteOverlays() {
  if (!map || !routeLine) return;

  const T = window.T;
  const path = waypoints.value.map((p) => new T.LngLat(p.lng, p.lat));
  routeLine.setLngLats(path);

  for (const marker of waypointMarkers) map.removeOverLay(marker);
  waypointMarkers = [];

  waypoints.value.forEach((point) => {
    const position = new T.LngLat(point.lng, point.lat);
    const dotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">
      <circle cx="6" cy="6" r="5" fill="#2563eb" stroke="white" stroke-width="2"/>
    </svg>`;
    const dotIcon = new T.Icon({
      iconUrl: 'data:image/svg+xml,' + encodeURIComponent(dotSvg),
      iconSize: new T.Point(12, 12),
      iconAnchor: new T.Point(6, 6)
    });
    const dotMarker = new T.Marker(position, { icon: dotIcon });

    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="18" viewBox="0 0 24 18">
      <rect x="0" y="0" width="24" height="18" rx="4" fill="#2563eb"/>
      <text x="12" y="13" text-anchor="middle" fill="white" font-size="12" font-weight="bold" font-family="Arial">${point.order}</text>
    </svg>`;
    const labelIcon = new T.Icon({
      iconUrl: 'data:image/svg+xml,' + encodeURIComponent(labelSvg),
      iconSize: new T.Point(24, 18),
      iconAnchor: new T.Point(-8, -8)
    });
    const labelMarker = new T.Marker(position, { icon: labelIcon });

    waypointMarkers.push(dotMarker, labelMarker);
    map.addOverLay(dotMarker);
    map.addOverLay(labelMarker);
  });
}

function updateHomeOverlay() {
  if (!map || !window.T) return;
  if (homeMarker) {
    map.removeOverLay(homeMarker);
    homeMarker = null;
  }
  if (!home.point) return;

  const T = window.T;
  const position = new T.LngLat(home.point.lng, home.point.lat);
  const homeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <circle cx="17" cy="17" r="15" fill="#f97316" stroke="white" stroke-width="3"/>
    <text x="17" y="22" text-anchor="middle" fill="white" font-size="15" font-weight="bold" font-family="Arial">H</text>
  </svg>`;
  const icon = new T.Icon({
    iconUrl: 'data:image/svg+xml,' + encodeURIComponent(homeSvg),
    iconSize: new T.Point(34, 34),
    iconAnchor: new T.Point(17, 17)
  });
  homeMarker = new T.Marker(position, { icon });
  map.addOverLay(homeMarker);
}

function addWaypoint(lnglat: any) {
  waypoints.value = [
    ...waypoints.value,
    {
      lng: lnglat.lng ?? lnglat.getLng(),
      lat: lnglat.lat ?? lnglat.getLat(),
      order: waypoints.value.length + 1
    }
  ];
}

function getMapClickLngLat(event: MouseEvent | PointerEvent) {
  if (!map || !mapContainer) return null;

  const tileLngLat = screenPointToLngLatFromTiles(event.clientX, event.clientY);
  if (tileLngLat) return tileLngLat;

  const mapRect = mapContainer.getBoundingClientRect();
  const scale = mapDisplayScale.value;
  const correctedX = (event.clientX - mapRect.left) / scale;
  const correctedY = (event.clientY - mapRect.top) / scale;

  return map.containerPointToLngLat?.([correctedX, correctedY])
    || map.vW?.([correctedX, correctedY])
    || containerPointToLngLatByMercator(correctedX, correctedY);
}

function screenPointToLngLatFromTiles(clientX: number, clientY: number) {
  if (!mapContainer) return null;

  const tiles = Array.from(mapContainer.querySelectorAll<HTMLImageElement>('.tdt-tile'));
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue;

    const src = tile.getAttribute('src') || '';
    const col = Number(src.match(/TILECOL=(\d+)/)?.[1]);
    const row = Number(src.match(/TILEROW=(\d+)/)?.[1]);
    const zoom = Number(src.match(/TILEMATRIX=(\d+)/)?.[1]);
    if (!Number.isFinite(col) || !Number.isFinite(row) || !Number.isFinite(zoom)) continue;

    const localX = ((clientX - rect.left) / rect.width) * 256;
    const localY = ((clientY - rect.top) / rect.height) * 256;
    return worldPixelToLngLat(col * 256 + localX, row * 256 + localY, 256 * 2 ** zoom);
  }

  return null;
}

function containerPointToLngLatByMercator(x: number, y: number) {
  if (!map || !mapContainer) return null;

  const center = map.getCenter?.();
  const zoom = map.getZoom?.();
  if (!center || typeof zoom !== 'number') return null;

  const centerLng = center.lng ?? center.getLng?.();
  const centerLat = center.lat ?? center.getLat?.();
  if (typeof centerLng !== 'number' || typeof centerLat !== 'number') return null;

  const mapRect = mapContainer.getBoundingClientRect();
  const scale = 256 * 2 ** zoom;
  const centerWorld = lngLatToWorldPixel(centerLng, centerLat, scale);
  const worldX = centerWorld.x + x - mapRect.width / 2;
  const worldY = centerWorld.y + y - mapRect.height / 2;

  return worldPixelToLngLat(worldX, worldY, scale);
}

function lngLatToWorldPixel(lng: number, lat: number, scale: number) {
  const sinLat = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale
  };
}

function worldPixelToLngLat(x: number, y: number, scale: number) {
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lng, lat };
}

function undoWaypoint() {
  waypoints.value = waypoints.value.slice(0, -1).map((point, index) => ({ ...point, order: index + 1 }));
}

function clearWaypoints() {
  waypoints.value = [];
}

function setMissionLoopCount(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Math.round(Number(input.value));
  missionLoopCount.value = clamp(Number.isFinite(value) ? value : 1, MISSION_LOOP_MIN, MISSION_LOOP_MAX);
}

function calculateRouteLength(points: Waypoint[]) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(points[index - 1], points[index]);
  }
  return total;
}

function haversineMeters(a: Pick<Waypoint, 'lat' | 'lng'>, b: Pick<Waypoint, 'lat' | 'lng'>) {
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

function formatDistance(meters: number) {
  if (!Number.isFinite(meters) || meters <= 0) return '0 m';
  if (meters < 1000) return `${meters.toFixed(1)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function centerOnShip() {
  if (!map || state.lat == null || state.lng == null) return;
  const T = window.T;
  map.centerAndZoom(new T.LngLat(state.lng, state.lat), 17);
}

function pruneTrack(now = Date.now()) {
  const next = track.value.filter((point) => now - point.recordedAt <= TRACK_WINDOW_MS);
  if (next.length !== track.value.length) track.value = next;
}

function onMapPointerDown(event: MouseEvent | PointerEvent) {
  mapPointerStart = { x: event.clientX, y: event.clientY };
}

function onMapPointerMove(event: MouseEvent | PointerEvent) {
  if (!mapPointerStart) return;
  if (Math.hypot(event.clientX - mapPointerStart.x, event.clientY - mapPointerStart.y) > 8) {
    suppressNextMapClick = true;
  }
  updateShipOverlayPosition();
}

function onMapPointerUp(event: MouseEvent | PointerEvent) {
  if ((planningEnabled.value || homePickingEnabled.value) && mapPointerStart) {
    const moved = Math.hypot(event.clientX - mapPointerStart.x, event.clientY - mapPointerStart.y);
    if (moved <= 8) {
      const lnglat = getMapClickLngLat(event);
      if (lnglat && homePickingEnabled.value) {
        homePickingEnabled.value = false;
        setHome({
          lng: lnglat.lng ?? lnglat.getLng(),
          lat: lnglat.lat ?? lnglat.getLat(),
          altitude: state.gpsAltitude
        });
      } else if (lnglat && planningEnabled.value) {
        addWaypoint(lnglat);
      }
    }
  }
  mapPointerStart = null;
  updateShipOverlayPosition();
}

function onMapPointerCancel() {
  mapPointerStart = null;
  suppressNextMapClick = false;
}

function onMapDragStart(event: DragEvent) {
  event.preventDefault();
}

function onDocumentMapPointerDown(event: MouseEvent | PointerEvent) {
  if (!isMapPointerEvent(event)) return;
  onMapPointerDown(event);
}

function onDocumentMapPointerMove(event: MouseEvent | PointerEvent) {
  if (!mapPointerStart) return;
  onMapPointerMove(event);
}

function onDocumentMapPointerUp(event: MouseEvent | PointerEvent) {
  if (!mapPointerStart) return;
  onMapPointerUp(event);
}

function onDocumentMapPointerCancel() {
  onMapPointerCancel();
}

function isMapPointerEvent(event: MouseEvent | PointerEvent) {
  if (!mapContainer) return false;
  const target = event.target;
  if (target instanceof Node && mapContainer.contains(target)) return true;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  return !!hit && (hit === mapContainer || mapContainer.contains(hit));
}

function setupMapPointerBehavior() {
  if (!mapContainer) return;

  const disableImageDrag = () => {
    mapContainer?.querySelectorAll('img').forEach((img) => {
      img.draggable = false;
    });
  };

  disableImageDrag();
  mapImageObserver?.disconnect();
  mapImageObserver = new MutationObserver(() => disableImageDrag());
  mapImageObserver.observe(mapContainer, { childList: true, subtree: true });
}

function bindMapMoveEvents() {
  const refresh = () => updateShipOverlayPosition();
  map?.addEventListener?.('move', refresh);
  map?.addEventListener?.('moveend', refresh);
  map?.addEventListener?.('zoom', refresh);
  map?.addEventListener?.('zoomend', refresh);
  map?.addEventListener?.('drag', refresh);
  map?.addEventListener?.('dragend', refresh);
}


</script>

<template>
  <main class="shell">
    <section class="topbar">
      <div>
        <p class="eyebrow">USV Cloud MVP</p>
        <h1>{{ state.deviceId }}</h1>
      </div>
      <div class="status-pills">
        <button class="view-tab" :class="{ active: activeView === 'console' }" @click="switchView('console')">控制台</button>
        <button class="view-tab" :class="{ active: activeView === 'logs' }" @click="switchView('logs')">事件日志</button>
        <span class="pill" :class="{ ok: wsConnected }">WS {{ wsConnected ? '连接' : '断开' }}</span>
        <span class="pill" :class="{ ok: state.online }">船端 {{ state.online ? '在线' : '离线' }}</span>
        <span class="pill" :class="{ ok: state.remoteKnown }">UDP {{ state.udpPort }}</span>
      </div>
    </section>

    <div v-if="showLowVoltageAlarm" class="voltage-alarm" role="alert">
      <div class="voltage-alarm__panel">
        <strong>低电压报警</strong>
        <span>当前电压 {{ voltageLabel }}，低于 22.00 V</span>
        <p>请关注返航状态；连续低于 21.60 V 将自动触发返航。</p>
        <button @click="muteLowVoltageAlarm">确认并静音</button>
      </div>
    </div>

    <section v-if="activeView === 'console'" class="layout">
      <div class="map-panel">
        <div
          :ref="bindMap"
          class="amap"
          :class="{ 'amap--display-scaled': mapDisplayScale > 1 }"
          :style="{ '--map-display-scale': mapDisplayScale }"
        ></div>
        <div
          v-if="shipOverlay.visible"
          class="ship-overlay"
          :class="{ online: shipOverlay.online }"
          :style="{ left: `${shipOverlay.left}px`, top: `${shipOverlay.top}px` }"
        >
          <div class="ship-overlay__arrow" :style="{ transform: `rotate(${shipOverlay.heading}deg)` }"></div>
          <div class="ship-overlay__label">{{ shipOverlay.online ? 'USV' : '待定位' }} {{ Math.round(shipOverlay.heading) }}deg</div>
        </div>
        <div v-if="state.lat == null || state.lng == null" class="map-empty">等待 GPS 位置数据</div>
        <div class="map-status">{{ mapStatusText }}</div>
        <div class="map-tools">
          <button @click="centerOnShip">定位船只</button>
          <button :class="{ active: planningEnabled }" @click="planningEnabled = !planningEnabled">
            {{ planningEnabled ? '规划开启' : '规划关闭' }}
          </button>
          <button :class="{ active: mapLayerMode === 'vector' }" @click="setMapLayer('vector')">矢量图</button>
          <button :class="{ active: mapLayerMode === 'satellite' }" @click="setMapLayer('satellite')">卫星图</button>
          <div class="map-scale-control" aria-label="显示放大">
            <button
              v-for="scale in mapDisplayScales"
              :key="scale"
              :class="{ active: mapDisplayScale === scale }"
              @click="setMapDisplayScale(scale)"
            >
              {{ scale }}x
            </button>
          </div>
          <span class="map-badge">{{ coordinateModeLabel }}</span>
        </div>
        <div class="map-joystick">
          <div class="map-joystick__title">手动摇杆</div>
          <div
            class="joystick joystick--compact"
            :class="{ active: joystick.active }"
            @pointerdown="onJoystickPointerDown"
            @pointermove="onJoystickPointerMove"
            @pointerup="onJoystickPointerUp"
            @pointercancel="onJoystickPointerUp"
            @contextmenu.prevent
          >
            <div class="joystick-axis horizontal"></div>
            <div class="joystick-axis vertical"></div>
            <div
              class="joystick-knob"
              :style="{ transform: `translate(calc(-50% + ${joystick.knobX}px), calc(-50% + ${joystick.knobY}px))` }"
            ></div>
          </div>
          <div class="joystick-readout joystick-readout--compact">
            <span>油门 {{ throttle.toFixed(2) }}</span>
            <span>转向 {{ steering.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <aside class="side">
        <div class="panel metrics">
          <div class="metric">
            <span>电压</span>
            <strong>{{ voltageLabel }}</strong>
          </div>
          <div class="metric">
            <span>电量</span>
            <strong>{{ batteryLabel }}</strong>
          </div>
          <div class="metric">
            <span>速度</span>
            <strong>{{ speedLabel }}</strong>
          </div>
          <div class="metric">
            <span>航向</span>
            <strong>{{ headingLabel }}</strong>
          </div>
          <div class="metric">
            <span>模式</span>
            <strong>{{ state.mode }}</strong>
          </div>
          <div class="metric">
            <span>GPS定位</span>
            <strong>{{ state.gpsFixLabel }}</strong>
          </div>
          <div class="metric">
            <span>卫星数</span>
            <strong>{{ gpsSatellitesLabel }}</strong>
          </div>
          <div class="metric">
            <span>HDOP</span>
            <strong>{{ gpsHdopLabel }}</strong>
          </div>
          <div class="metric">
            <span>Autopilot</span>
            <strong>{{ state.autopilot ?? '--' }}</strong>
          </div>
          <div class="metric">
            <span>解锁</span>
            <strong>{{ state.armed ? 'ARMED' : 'SAFE' }}</strong>
          </div>
        </div>

        <div class="panel readout">
          <div><span>经度</span><b>{{ state.lng?.toFixed(7) ?? '--' }}</b></div>
          <div><span>纬度</span><b>{{ state.lat?.toFixed(7) ?? '--' }}</b></div>
          <div><span>GPS高度</span><b>{{ gpsAltitudeLabel }}</b></div>
          <div><span>水平精度</span><b>{{ gpsAccuracyLabel }}</b></div>
          <div><span>VDOP</span><b>{{ state.gpsVdop?.toFixed(2) ?? '--' }}</b></div>
          <div><span>卫星信号</span><b>{{ gpsSignalLabel }}</b></div>
          <div><span>custom_mode</span><b>{{ state.customMode ?? '--' }}</b></div>
          <div><span>base_mode</span><b>{{ state.baseMode ?? '--' }}</b></div>
          <div><span>vehicle_type</span><b>{{ state.vehicleType ?? '--' }}</b></div>
          <div><span>最近心跳</span><b>{{ lastSeenLabel }}</b></div>
          <p>{{ statusText }}</p>
        </div>

        <div class="panel route-panel">
          <div class="route-title">
            <span>航线规划</span>
            <strong>{{ waypoints.length }} 点</strong>
          </div>
          <div class="route-actions">
            <button @click="undoWaypoint" :disabled="waypoints.length === 0">撤销</button>
            <button @click="clearWaypoints" :disabled="waypoints.length === 0">清空</button>
          </div>
          <div class="home-panel">
            <div class="home-panel__header">
              <span>返航点 Home</span>
              <strong :class="`home-status home-status--${home.syncStatus}`">{{ homeStatusLabel }}</strong>
            </div>
            <div class="home-panel__coords">{{ homeLabel }}</div>
            <div v-if="home.lastError" class="home-panel__error">{{ home.lastError }}</div>
            <div class="home-panel__actions">
              <button @click="setHomeFromCurrent" :disabled="state.lat == null || state.lng == null">设为当前位置</button>
              <button :class="{ active: homePickingEnabled }" @click="toggleHomePicking">
                {{ homePickingEnabled ? '点击地图中' : '地图点选 Home' }}
              </button>
            </div>
          </div>
          <div class="route-summary">
            <div><span>航线长度</span><strong>{{ routeLengthLabel }}</strong></div>
            <div><span>上传任务项</span><strong>{{ missionUploadItemCount }} 项</strong></div>
            <label>
              <span>循环次数</span>
              <input
                type="number"
                :min="MISSION_LOOP_MIN"
                :max="MISSION_LOOP_MAX"
                :value="missionLoopCount"
                @input="setMissionLoopCount"
              />
            </label>
          </div>
          <ol v-if="waypoints.length > 0" class="waypoint-list">
            <li v-for="point in waypoints" :key="point.order">
              <b>{{ point.order }}</b>
              <span>{{ point.lng.toFixed(6) }}, {{ point.lat.toFixed(6) }}</span>
            </li>
          </ol>
          <p v-else>在地图上点击添加航点</p>

          <div class="mission-controls">
            <div class="mission-status">
              <span>任务状态：</span>
              <strong>{{ missionStatusLabel }}</strong>
              <span v-if="mission.status === 'active' || mission.status === 'paused'">
                (任务项 {{ mission.currentWaypoint + 1 }}/{{ mission.totalWaypoints }})
              </span>
              <em v-if="missionLoopProgressLabel">{{ missionLoopProgressLabel }}</em>
            </div>
            <div class="mission-buttons">
              <button v-if="mission.status === 'idle'" @click="uploadMission" :disabled="waypoints.length === 0">
                写入航点
              </button>
              <button v-if="mission.status === 'ready'" @click="startMission">
                开始执行
              </button>
              <button v-if="mission.status === 'active'" @click="pauseMission">
                暂停任务
              </button>
              <button v-if="mission.status === 'paused'" @click="resumeMission">
                继续任务
              </button>
              <button v-if="mission.status !== 'idle'" @click="clearMission" class="danger">
                清除任务
              </button>
            </div>
          </div>
        </div>

        <div class="panel controls">
          <div class="mode-switch">
            <span>模式切换</span>
            <div>
              <button v-for="mode in controlModes" :key="mode.key" @click="setMode(mode.key)">
                {{ mode.label }}
              </button>
            </div>
          </div>

          <div class="buttons">
            <button @click="command('control.arm')">解锁</button>
            <button @click="command('control.disarm')">上锁</button>
            <button class="danger" @click="command('control.emergencyStop')">急停</button>
            <button class="danger" :disabled="!state.online" @click="rebootAutopilot">重启飞控</button>
            <button @click="returnHomeNow" :disabled="home.syncStatus !== 'accepted' || !state.online">返航</button>
          </div>

          <div class="sticks">
            <div class="stick-column">
              <span>油门</span>
              <button @mousedown="nudge('throttle', 0.55)" @mouseup="zeroControl" @mouseleave="zeroControl">前进</button>
              <button @mousedown="nudge('throttle', -0.35)" @mouseup="zeroControl" @mouseleave="zeroControl">后退</button>
            </div>
            <div class="stick-column">
              <span>转向</span>
              <button @mousedown="nudge('steering', -0.55)" @mouseup="zeroControl" @mouseleave="zeroControl">左转</button>
              <button @mousedown="nudge('steering', 0.55)" @mouseup="zeroControl" @mouseleave="zeroControl">右转</button>
            </div>
          </div>

          <div class="bars">
            <label>油门 <progress max="2" :value="throttle + 1"></progress></label>
            <label>转向 <progress max="2" :value="steering + 1"></progress></label>
          </div>
        </div>
      </aside>
    </section>

    <section v-else class="logs-page">
      <div class="logs-toolbar panel">
        <label>
          <span>开始</span>
          <input v-model="logFilters.from" type="datetime-local" />
        </label>
        <label>
          <span>结束</span>
          <input v-model="logFilters.to" type="datetime-local" />
        </label>
        <label>
          <span>级别</span>
          <select v-model="logFilters.level">
            <option value="">全部</option>
            <option value="debug">debug</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </label>
        <label>
          <span>类别</span>
          <select v-model="logFilters.category">
            <option value="">全部</option>
            <option value="control">control</option>
            <option value="ack">ack</option>
            <option value="statustext">statustext</option>
            <option value="mission">mission</option>
            <option value="link">link</option>
            <option value="power">power</option>
            <option value="service">service</option>
          </select>
        </label>
        <label>
          <span>类型</span>
          <input v-model.trim="logFilters.type" placeholder="control_tx" />
        </label>
        <button @click="loadLogs" :disabled="logsLoading">{{ logsLoading ? '加载中' : '刷新' }}</button>
        <button @click="exportLogs('events')">导出事件</button>
        <button @click="exportLogs('telemetry')">导出遥测</button>
      </div>

      <p v-if="logsError" class="logs-error">{{ logsError }}</p>

      <div class="logs-grid">
        <div class="panel log-panel">
          <div class="log-panel__title">
            <strong>事件日志</strong>
            <span>{{ eventRows.length }} 条</span>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>级别</th>
                  <th>类别</th>
                  <th>类型</th>
                  <th>消息</th>
                  <th>模式</th>
                  <th>解锁</th>
                  <th>GPS</th>
                  <th>电压</th>
                </tr>
              </thead>
              <tbody>
                <template v-for="row in eventRows" :key="row.id">
                  <tr class="clickable-row" @click="expandedEventId = expandedEventId === row.id ? null : row.id">
                    <td>{{ formatLogTime(row.occurred_at) }}</td>
                    <td><span class="level-chip" :class="row.level">{{ row.level }}</span></td>
                    <td>{{ row.category }}</td>
                    <td>{{ row.type }}</td>
                    <td class="message-cell">{{ row.message }}</td>
                    <td>{{ row.mode ?? '--' }}</td>
                    <td>{{ row.armed === 1 ? 'ARMED' : row.armed === 0 ? 'SAFE' : '--' }}</td>
                    <td>{{ eventGps(row) }}</td>
                    <td>{{ eventVoltage(row) }}</td>
                  </tr>
                  <tr v-if="expandedEventId === row.id" class="detail-row">
                    <td colspan="9">
                      <div class="detail-grid">
                        <div><b>command</b><span>{{ row.command ?? '--' }}</span></div>
                        <div><b>result</b><span>{{ row.result ?? '--' }}</span></div>
                      </div>
                      <pre>{{ row.details_json || '{}' }}</pre>
                      <pre v-if="row.raw_hex">raw_hex: {{ row.raw_hex }}</pre>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>

        <div class="panel log-panel">
          <div class="log-panel__title">
            <strong>遥测采样</strong>
            <span>{{ telemetryRows.length }} 条</span>
          </div>
          <div class="table-wrap">
            <table class="log-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>电压</th>
                  <th>电流</th>
                  <th>电量</th>
                  <th>GPS</th>
                  <th>卫星</th>
                  <th>HDOP</th>
                  <th>坐标</th>
                  <th>速度</th>
                  <th>航向</th>
                  <th>模式</th>
                  <th>解锁</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in telemetryRows" :key="row.id">
                  <td>{{ formatLogTime(row.occurred_at) }}</td>
                  <td>{{ formatNullable(row.voltage) }}</td>
                  <td>{{ formatNullable(row.current) }}</td>
                  <td>{{ row.battery_percent ?? '--' }}</td>
                  <td>{{ row.gps_fix_label ?? '--' }}</td>
                  <td>{{ row.gps_satellites ?? '--' }}</td>
                  <td>{{ formatNullable(row.gps_hdop) }}</td>
                  <td>{{ formatNullable(row.lng, 7) }}, {{ formatNullable(row.lat, 7) }}</td>
                  <td>{{ formatNullable(row.speed) }}</td>
                  <td>{{ formatNullable(row.heading, 1) }}</td>
                  <td>{{ row.mode ?? '--' }}</td>
                  <td>{{ row.armed === 1 ? 'ARMED' : row.armed === 0 ? 'SAFE' : '--' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  </main>
</template>
