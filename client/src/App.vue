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
  waitSeconds: number;
  captureEnabled?: boolean;
  capturePointIndex?: number;
  expectedPhotoCount?: number;
  captureStepDeg?: number;
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

type CaptureImage = {
  id: number;
  photo_index: number;
  point_index?: number | null;
  capture_date?: string | null;
  angle_deg: number | null;
  uploaded_at: string;
  detection?: CaptureDetection | null;
};

type CaptureDetection = {
  id: number;
  image_id: number;
  status: string;
  model_path: string | null;
  device: string | null;
  inference_ms: number | null;
  detections_json: string | null;
  detected_count: number;
  annotated_path: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type CapturePoint = {
  plan: {
    mission_id: string;
    capture_point_index: number;
    point_index?: number | null;
    capture_date?: string | null;
    device_id?: string;
    waypoint_seq: number;
    lat: number;
    lng: number;
    wait_seconds: number;
    expected_photo_count: number;
    capture_step_deg: number;
    reupload_attempts: number;
    status: string;
  };
  images: CaptureImage[];
  received: number;
  missing: number[];
  complete: boolean;
};

type CaptureMission = {
  missionId: string | null;
  captureDate?: string | null;
  deviceId?: string | null;
  points: CapturePoint[];
};

type PiClientStatus = {
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

type PiStatus = {
  online: boolean;
  connectionCount: number;
  clients: PiClientStatus[];
  lastOutbound: { type: string; sentAt: string; data: unknown } | null;
};

type DetectionSettings = {
  enabled: boolean;
  modelPath: string;
  confidence: number;
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
const WAYPOINT_WAIT_MIN_SECONDS = 0;
const WAYPOINT_WAIT_MAX_SECONDS = 600;
const CAPTURE_DEFAULT_WAIT_SECONDS = 60;
const CAPTURE_DEFAULT_PHOTO_COUNT = 10;
const CAPTURE_DEFAULT_STEP_DEG = 36;
const CAPTURE_PHOTO_COUNT_MIN = 1;
const CAPTURE_PHOTO_COUNT_MAX = 200;
const CAPTURE_STEP_MIN = 1;
const CAPTURE_STEP_MAX = 360;
const CAMERA_TRIGGER_RELAY = 0;
const CAMERA_TRIGGER_PULSE_SECONDS = 1;
const LOW_VOLTAGE_ALARM_THRESHOLD = 22;
const LOW_VOLTAGE_ALARM_SAMPLES = 5;
const LOW_VOLTAGE_ALARM_SAMPLE_MS = 1000;
const mission = reactive<MissionState>({
  status: 'idle',
  waypoints: [],
  currentWaypoint: 0,
  totalWaypoints: 0
});
const captureMission = reactive<CaptureMission>({
  missionId: null,
  captureDate: null,
  deviceId: null,
  points: []
});
const piStatus = reactive<PiStatus>({
  online: false,
  connectionCount: 0,
  clients: [],
  lastOutbound: null
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
const activeView = ref<'console' | 'logs' | 'camera'>('console');
const homePickingEnabled = ref(false);
const lowVoltageMinimized = ref(false);
const lowVoltageAlarmActive = ref(false);
const cameraTriggerLoading = ref(false);
const cameraTriggerMessage = ref('');
const cameraTriggerError = ref('');
const testPlanLoading = ref(false);
const testPlanMessage = ref('');
const testPlanError = ref('');
const commandInput = ref('');
const commandInputLoading = ref(false);
const commandInputResult = ref('');
const commandInputError = ref('');
const detectionSettings = reactive<DetectionSettings>({
  enabled: true,
  modelPath: '',
  confidence: 0.25
});
const detectionSettingsLoading = ref(false);
const detectionSettingsError = ref('');
const logFilters = reactive({
  from: toLocalDateInput(new Date(Date.now() - 60 * 60 * 1000)),
  to: toLocalDateInput(new Date()),
  level: '',
  category: '',
  type: '',
  q: ''
});
const eventRows = ref<EventLogRow[]>([]);
const telemetryRows = ref<TelemetrySampleRow[]>([]);
const expandedEventId = ref<number | null>(null);
const logsLoading = ref(false);
const logsError = ref('');

let ws: WebSocket | null = null;
let controlTimer: number | null = null;
let piStatusTimer: number | null = null;
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
let lowVoltageAlarmSampleCount = 0;
let lastLowVoltageAlarmSampleAt = 0;
let lowVoltageAudioContext: AudioContext | null = null;
let lowVoltageAlarmSoundTimer: number | null = null;

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
const captureWaypointCount = computed(() => waypoints.value.filter((point) => point.captureEnabled).length);
const missionUploadItemCount = computed(() => waypoints.value.length === 0 ? 0 : waypoints.value.length + 1 + captureWaypointCount.value + (missionLoopCount.value > 1 ? 1 : 0));
const captureMissionLabel = computed(() => {
  if (captureMission.captureDate) return `date=${captureMission.captureDate}`;
  return captureMission.missionId ? `mission=${captureMission.missionId}` : '--';
});
const captureExpectedTotal = computed(() => captureMission.points.reduce((sum, point) => sum + point.plan.expected_photo_count, 0));
const captureReceivedTotal = computed(() => captureMission.points.reduce((sum, point) => sum + point.received, 0));
const captureCompletionLabel = computed(() => `${captureReceivedTotal.value}/${captureExpectedTotal.value || 0}`);
const cameraTriggerDisabled = computed(() => cameraTriggerLoading.value || !state.online || !state.remoteKnown);
const primaryPiClient = computed(() => piStatus.clients[0] ?? null);
const piHeartbeatLabel = computed(() => primaryPiClient.value?.lastHeartbeatAt ? new Date(primaryPiClient.value.lastHeartbeatAt).toLocaleTimeString() : '--');
const piRegisteredLabel = computed(() => primaryPiClient.value?.registeredAt ? new Date(primaryPiClient.value.registeredAt).toLocaleTimeString() : '--');
const piLastMessageLabel = computed(() => primaryPiClient.value?.lastMessageType || '--');
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
const lowVoltageActive = computed(() => lowVoltageAlarmActive.value);
const showLowVoltageAlarm = computed(() => lowVoltageActive.value && !lowVoltageMinimized.value);
const showLowVoltageAlarmIcon = computed(() => lowVoltageActive.value && lowVoltageMinimized.value);
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
watch(showLowVoltageAlarm, (visible) => {
  if (visible) startLowVoltageAlarmSound();
  else stopLowVoltageAlarmSound();
});

onMounted(() => {
  connectWs();
  window.addEventListener('pointerdown', unlockLowVoltageAlarmAudio, { once: true });
  window.addEventListener('keydown', unlockLowVoltageAlarmAudio, { once: true });
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
  loadCaptureStatus();
  loadPiStatus();
  loadDetectionSettings();
  piStatusTimer = window.setInterval(loadPiStatus, 3000);
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
  if (piStatusTimer) window.clearInterval(piStatusTimer);
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  window.removeEventListener('pointerdown', unlockLowVoltageAlarmAudio);
  window.removeEventListener('keydown', unlockLowVoltageAlarmAudio);
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
  stopLowVoltageAlarmSound();
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
      const wasOnline = state.online;
      Object.assign(state, message.data);
      observeLowVoltageAlarm(wasOnline);
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
      if (message.data.missionId) loadCaptureStatus(message.data.missionId);
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
    if (message.type === 'capture.updated' || message.type === 'capture.plan') {
      applyCaptureMission(message.data);
    }
    if (message.type === 'detections.settings') {
      Object.assign(detectionSettings, message.data);
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

async function loadCaptureStatus(missionId?: string | null) {
  try {
    const url = missionId ? `/api/captures?missionId=${encodeURIComponent(missionId)}` : '/api/captures';
    const response = await fetch(url);
    const result = await response.json() as { data?: CaptureMission };
    if (result.data) applyCaptureMission(result.data);
  } catch (error) {
    console.warn(error);
  }
}

async function loadPiStatus() {
  try {
    const response = await fetch('/api/pi/status');
    const result = await response.json() as { data?: PiStatus };
    if (result.data) {
      piStatus.online = result.data.online;
      piStatus.connectionCount = result.data.connectionCount;
      piStatus.clients = result.data.clients || [];
      piStatus.lastOutbound = result.data.lastOutbound;
    }
  } catch (error) {
    console.warn(error);
  }
}

async function loadDetectionSettings() {
  try {
    const response = await fetch('/api/detections/settings');
    const result = await response.json() as { data?: DetectionSettings };
    if (result.data) Object.assign(detectionSettings, result.data);
  } catch (error) {
    console.warn(error);
  }
}

async function toggleDetectionSettings() {
  detectionSettingsLoading.value = true;
  detectionSettingsError.value = '';
  try {
    const nextEnabled = !detectionSettings.enabled;
    const result = await postJson<{ ok: boolean; message?: string; data?: DetectionSettings }>('/api/detections/settings', {
      enabled: nextEnabled
    });
    if (result.data) Object.assign(detectionSettings, result.data);
    statusText.value = result.message || (nextEnabled ? 'AI 识别过滤已开启' : 'AI 识别过滤已关闭');
  } catch (error) {
    detectionSettingsError.value = error instanceof Error ? error.message : '未知错误';
    statusText.value = `AI 识别设置失败：${detectionSettingsError.value}`;
  } finally {
    detectionSettingsLoading.value = false;
  }
}

function applyCaptureMission(data: unknown) {
  const payload = data as Partial<CaptureMission> & { plans?: unknown[] };
  if ('points' in payload) {
    captureMission.missionId = payload.missionId ?? null;
    captureMission.captureDate = payload.captureDate ?? null;
    captureMission.deviceId = payload.deviceId ?? null;
    captureMission.points = Array.isArray(payload.points) ? payload.points as CapturePoint[] : [];
    return;
  }
  if ('missionId' in payload && 'plans' in payload) {
    captureMission.missionId = payload.missionId ?? null;
    captureMission.captureDate = null;
    captureMission.deviceId = null;
    captureMission.points = [];
  }
}

async function triggerCameraCapture() {
  cameraTriggerLoading.value = true;
  cameraTriggerMessage.value = '';
  cameraTriggerError.value = '';
  try {
    const result = await postJson<{ ok: boolean; message?: string; data?: { relay: number; pulseSeconds: number } }>('/api/camera/trigger', {
      relay: CAMERA_TRIGGER_RELAY,
      pulseSeconds: CAMERA_TRIGGER_PULSE_SECONDS
    });
    cameraTriggerMessage.value = result.message || '高电平触发已发送';
    statusText.value = cameraTriggerMessage.value;
  } catch (error) {
    cameraTriggerError.value = error instanceof Error ? error.message : '未知错误';
    statusText.value = `触发拍摄失败：${cameraTriggerError.value}`;
  } finally {
    cameraTriggerLoading.value = false;
  }
}

async function sendCommandInput() {
  const command = commandInput.value.trim();
  if (!command) return;
  commandInputLoading.value = true;
  commandInputResult.value = '';
  commandInputError.value = '';
  try {
    const result = await postJson<{ ok: boolean; message?: string; data?: unknown }>('/api/command-line', { command });
    commandInputResult.value = result.message || '指令已发送';
    statusText.value = commandInputResult.value;
  } catch (error) {
    commandInputError.value = error instanceof Error ? error.message : '未知错误';
    statusText.value = `指令发送失败：${commandInputError.value}`;
  } finally {
    commandInputLoading.value = false;
  }
}

async function createTestCapturePlan() {
  testPlanLoading.value = true;
  testPlanMessage.value = '';
  testPlanError.value = '';
  try {
    const result = await postJson<{ code: number; message?: string; data?: CaptureMission }>('/api/capture-plan/test', {
      deviceId: state.deviceId,
      expectedPhotoCount: CAPTURE_DEFAULT_PHOTO_COUNT,
      captureStepDeg: CAPTURE_DEFAULT_STEP_DEG,
      waitSeconds: CAPTURE_DEFAULT_WAIT_SECONDS
    });
    if (result.data) applyCaptureMission(result.data);
    testPlanMessage.value = `${result.message || '测试拍摄计划已创建'}：${captureMissionLabel.value}`;
    statusText.value = testPlanMessage.value;
  } catch (error) {
    testPlanError.value = error instanceof Error ? error.message : '未知错误';
    statusText.value = `创建测试计划失败：${testPlanError.value}`;
  } finally {
    testPlanLoading.value = false;
  }
}

function capturePhotoCells(point: CapturePoint) {
  const uploaded = new Map(point.images.map((image) => [image.photo_index, image]));
  return Array.from({ length: point.plan.expected_photo_count }, (_, index) => {
    const photoIndex = index + 1;
    return {
      photoIndex,
      image: uploaded.get(photoIndex) ?? null
    };
  });
}

function detectionLabel(image: CaptureImage | null) {
  if (!image) return '';
  const detection = image.detection;
  if (!detection || detection.status === 'skipped') return '未启用识别';
  if (detection.status === 'pending') return '待识别';
  if (detection.status === 'running') return '识别中';
  if (detection.status === 'failed') return '识别失败';
  if (detection.status === 'complete') return detection.detected_count > 0 ? `排口 ${detection.detected_count}` : '无排口';
  return detection.status;
}

function detectionClass(image: CaptureImage | null) {
  const status = image?.detection?.status;
  if (!status || status === 'skipped') return 'skipped';
  if (status === 'complete' && (image?.detection?.detected_count ?? 0) > 0) return 'detected';
  if (status === 'failed') return 'failed';
  return status;
}

function capturePointIndexLabel(point: CapturePoint): number {
  return point.plan.point_index ?? point.plan.capture_point_index;
}

function capturePointDateLabel(point: CapturePoint): string {
  return point.plan.capture_date || captureMission.captureDate || '--';
}

function capturePointKey(point: CapturePoint): string {
  return `${point.plan.device_id || captureMission.deviceId || 'device'}-${capturePointDateLabel(point)}-${capturePointIndexLabel(point)}`;
}

function capturePointTitle(point: CapturePoint): string {
  return `date=${capturePointDateLabel(point)} point=${capturePointIndexLabel(point)}`;
}

function openCaptureLogs() {
  logFilters.from = toLocalDateInput(new Date(Date.now() - 60 * 60 * 1000));
  logFilters.to = toLocalDateInput(new Date());
  logFilters.level = '';
  logFilters.category = 'capture';
  logFilters.type = '';
  logFilters.q = '';
  activeView.value = 'logs';
  loadLogs();
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

function minimizeLowVoltageAlarm() {
  lowVoltageMinimized.value = true;
  stopLowVoltageAlarmSound();
}

function expandLowVoltageAlarm() {
  lowVoltageMinimized.value = false;
  unlockLowVoltageAlarmAudio();
}

function observeLowVoltageAlarm(wasOnline: boolean) {
  if (!state.online) {
    resetLowVoltageAlarm(false);
    return;
  }

  if (!wasOnline && state.online) {
    resetLowVoltageAlarm(true);
  }

  const now = Date.now();
  if (now - lastLowVoltageAlarmSampleAt < LOW_VOLTAGE_ALARM_SAMPLE_MS) return;
  lastLowVoltageAlarmSampleAt = now;

  if (state.voltage !== null && state.voltage < LOW_VOLTAGE_ALARM_THRESHOLD) {
    lowVoltageAlarmSampleCount += 1;
    if (lowVoltageAlarmSampleCount >= LOW_VOLTAGE_ALARM_SAMPLES) {
      lowVoltageAlarmActive.value = true;
    }
    return;
  }

  lowVoltageAlarmSampleCount = 0;
  lowVoltageAlarmActive.value = false;
}

function resetLowVoltageAlarm(clearMuted: boolean) {
  lowVoltageAlarmSampleCount = 0;
  lastLowVoltageAlarmSampleAt = 0;
  lowVoltageAlarmActive.value = false;
  if (clearMuted) lowVoltageMinimized.value = false;
}

function unlockLowVoltageAlarmAudio() {
  const AudioContextCtor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  lowVoltageAudioContext ??= new AudioContextCtor();
  if (lowVoltageAudioContext.state === 'suspended') {
    void lowVoltageAudioContext.resume()
      .then(() => {
        if (showLowVoltageAlarm.value) playLowVoltageBeep();
      })
      .catch(() => undefined);
    return;
  }
  if (showLowVoltageAlarm.value) playLowVoltageBeep();
}

function enableLowVoltageAlarmSound() {
  unlockLowVoltageAlarmAudio();
  playLowVoltageBeep();
}

function startLowVoltageAlarmSound() {
  unlockLowVoltageAlarmAudio();
  if (lowVoltageAlarmSoundTimer !== null) return;
  playLowVoltageBeep();
  lowVoltageAlarmSoundTimer = window.setInterval(playLowVoltageBeep, 900);
}

function stopLowVoltageAlarmSound() {
  if (lowVoltageAlarmSoundTimer === null) return;
  window.clearInterval(lowVoltageAlarmSoundTimer);
  lowVoltageAlarmSoundTimer = null;
}

function playLowVoltageBeep() {
  const context = lowVoltageAudioContext;
  if (!context || context.state !== 'running') return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;

  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.28, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.22);
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
  if (logFilters.q) params.set('q', logFilters.q);
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

function switchView(view: 'console' | 'logs' | 'camera') {
  activeView.value = view;
  if (view === 'logs' && eventRows.value.length === 0 && telemetryRows.value.length === 0) {
    loadLogs();
  }
  if (view === 'camera') {
    loadCaptureStatus(captureMission.missionId);
    loadPiStatus();
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
      order: waypoints.value.length + 1,
      waitSeconds: 0,
      captureEnabled: false,
      expectedPhotoCount: CAPTURE_DEFAULT_PHOTO_COUNT,
      captureStepDeg: CAPTURE_DEFAULT_STEP_DEG
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

function setWaypointWait(point: Waypoint, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Math.round(Number(input.value));
  const waitSeconds = clamp(Number.isFinite(value) ? value : 0, WAYPOINT_WAIT_MIN_SECONDS, WAYPOINT_WAIT_MAX_SECONDS);
  waypoints.value = waypoints.value.map((item) => (
    item.order === point.order ? { ...item, waitSeconds } : item
  ));
}

function setWaypointCapture(point: Waypoint, event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  waypoints.value = waypoints.value.map((item) => (
    item.order === point.order
      ? {
          ...item,
          captureEnabled: enabled,
          waitSeconds: enabled && item.waitSeconds === 0 ? CAPTURE_DEFAULT_WAIT_SECONDS : item.waitSeconds,
          expectedPhotoCount: item.expectedPhotoCount ?? CAPTURE_DEFAULT_PHOTO_COUNT,
          captureStepDeg: item.captureStepDeg ?? CAPTURE_DEFAULT_STEP_DEG
        }
      : item
  ));
}

function setWaypointExpectedPhotos(point: Waypoint, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Math.round(Number(input.value));
  const expectedPhotoCount = clamp(Number.isFinite(value) ? value : CAPTURE_DEFAULT_PHOTO_COUNT, CAPTURE_PHOTO_COUNT_MIN, CAPTURE_PHOTO_COUNT_MAX);
  waypoints.value = waypoints.value.map((item) => item.order === point.order ? { ...item, expectedPhotoCount } : item);
}

function setWaypointCaptureStep(point: Waypoint, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Math.round(Number(input.value));
  const captureStepDeg = clamp(Number.isFinite(value) ? value : CAPTURE_DEFAULT_STEP_DEG, CAPTURE_STEP_MIN, CAPTURE_STEP_MAX);
  waypoints.value = waypoints.value.map((item) => item.order === point.order ? { ...item, captureStepDeg } : item);
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
        <button class="view-tab" :class="{ active: activeView === 'camera' }" @click="switchView('camera')">摄像头测试</button>
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
        <button @click="enableLowVoltageAlarmSound">启用声音</button>
        <button @click="minimizeLowVoltageAlarm">静音并最小化</button>
      </div>
    </div>

    <button
      v-if="showLowVoltageAlarmIcon"
      class="voltage-alarm-icon"
      type="button"
      title="低电压报警"
      @click="expandLowVoltageAlarm"
    >
      <span>!</span>
      <b>{{ voltageLabel }}</b>
    </button>

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
              <div class="waypoint-main">
                <span>{{ point.lng.toFixed(6) }}, {{ point.lat.toFixed(6) }}</span>
                <label class="waypoint-wait">
                  <span>等待</span>
                  <input
                    type="number"
                    :min="WAYPOINT_WAIT_MIN_SECONDS"
                    :max="WAYPOINT_WAIT_MAX_SECONDS"
                    :value="point.waitSeconds"
                    @input="setWaypointWait(point, $event)"
                  />
                  <span>秒</span>
                </label>
              </div>
              <div class="waypoint-capture">
                <label>
                  <input
                    type="checkbox"
                    :checked="point.captureEnabled"
                    @change="setWaypointCapture(point, $event)"
                  />
                  <span>拍照点</span>
                </label>
                <label v-if="point.captureEnabled">
                  <span>张数</span>
                  <input
                    type="number"
                    :min="CAPTURE_PHOTO_COUNT_MIN"
                    :max="CAPTURE_PHOTO_COUNT_MAX"
                    :value="point.expectedPhotoCount ?? CAPTURE_DEFAULT_PHOTO_COUNT"
                    @input="setWaypointExpectedPhotos(point, $event)"
                  />
                </label>
                <label v-if="point.captureEnabled">
                  <span>角度</span>
                  <input
                    type="number"
                    :min="CAPTURE_STEP_MIN"
                    :max="CAPTURE_STEP_MAX"
                    :value="point.captureStepDeg ?? CAPTURE_DEFAULT_STEP_DEG"
                    @input="setWaypointCaptureStep(point, $event)"
                  />
                </label>
              </div>
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

          <div class="capture-records">
            <div class="capture-records__head">
              <span>拍摄记录</span>
              <strong>{{ captureMissionLabel }}</strong>
              <button @click="loadCaptureStatus(captureMission.missionId)">刷新</button>
            </div>
            <div v-if="captureMission.points.length === 0" class="capture-empty">暂无拍摄计划</div>
            <div v-else class="capture-point" v-for="point in captureMission.points" :key="capturePointKey(point)">
              <div>
                <b>{{ capturePointTitle(point) }}</b>
                <span>{{ point.received }}/{{ point.plan.expected_photo_count }}</span>
                <em :class="{ complete: point.complete }">{{ point.complete ? 'complete' : point.plan.status }}</em>
              </div>
              <p v-if="point.missing.length > 0">缺失：{{ point.missing.join(', ') }}</p>
              <p v-else>照片完整</p>
              <div class="capture-images" v-if="point.images.length > 0">
                <a
                  v-for="image in point.images"
                  :key="image.id"
                  :href="`/api/captures/${image.id}/original`"
                  target="_blank"
                  rel="noreferrer"
                >
                  #{{ image.photo_index }}
                </a>
              </div>
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

          <div class="command-console">
            <div>
              <span>指令输入</span>
              <small>arm / mode hold / manual 0.2 0 / relay 0 1 / mavcmd ...</small>
            </div>
            <form @submit.prevent="sendCommandInput">
              <input
                v-model.trim="commandInput"
                type="text"
                placeholder="输入要发送给船或飞控的指令"
                autocomplete="off"
              />
              <button type="submit" :disabled="commandInputLoading || !commandInput.trim()">
                {{ commandInputLoading ? '发送中' : '发送' }}
              </button>
            </form>
            <p v-if="commandInputResult" class="command-console__ok">{{ commandInputResult }}</p>
            <p v-if="commandInputError" class="command-console__error">{{ commandInputError }}</p>
          </div>
        </div>
      </aside>
    </section>

    <section v-else-if="activeView === 'camera'" class="camera-page">
      <div class="panel camera-hero">
        <div>
          <p class="eyebrow">Camera Test</p>
          <h2>树莓派摄像头联调</h2>
          <p>船控输出高电平后，树莓派内部完成电机旋转一圈和 10 张拍摄；云端只负责触发、接收和验收。</p>
        </div>
        <div class="camera-summary">
          <span>{{ captureMissionLabel }}</span>
          <strong>{{ captureCompletionLabel }}</strong>
          <em>{{ piStatus.online ? '树莓派在线' : '树莓派离线' }} · {{ state.online ? '船端在线' : '船端离线' }}</em>
        </div>
      </div>

      <div class="camera-grid">
        <div class="panel camera-card">
          <div class="camera-card__title">
            <strong>树莓派连接</strong>
            <span>{{ piStatus.connectionCount }} 个连接</span>
          </div>
          <dl class="camera-endpoints">
            <div>
              <dt>状态</dt>
              <dd>{{ piStatus.online ? '在线' : '离线' }}</dd>
            </div>
            <div>
              <dt>Pi ID</dt>
              <dd>{{ primaryPiClient?.piId || '--' }}</dd>
            </div>
            <div>
              <dt>Device ID</dt>
              <dd>{{ primaryPiClient?.deviceId || '--' }}</dd>
            </div>
            <div>
              <dt>注册时间</dt>
              <dd>{{ piRegisteredLabel }}</dd>
            </div>
            <div>
              <dt>最近心跳</dt>
              <dd>{{ piHeartbeatLabel }}</dd>
            </div>
            <div>
              <dt>最近消息</dt>
              <dd>{{ piLastMessageLabel }}</dd>
            </div>
            <div>
              <dt>最近下发</dt>
              <dd>{{ piStatus.lastOutbound?.type || '--' }}</dd>
            </div>
          </dl>
          <button @click="loadPiStatus">刷新连接状态</button>
        </div>

        <div class="panel camera-card">
          <div class="camera-card__title">
            <strong>船控高电平触发测试</strong>
            <span>Relay {{ CAMERA_TRIGGER_RELAY }} / {{ CAMERA_TRIGGER_PULSE_SECONDS }} 秒</span>
          </div>
          <p>点击后云端向飞控发送 relay 高电平，再自动拉低，用于单独测试树莓派拍摄流程。</p>
          <button class="camera-trigger" :disabled="cameraTriggerDisabled" @click="triggerCameraCapture">
            {{ cameraTriggerLoading ? '发送中' : '触发拍摄' }}
          </button>
          <p v-if="!state.online || !state.remoteKnown" class="camera-warning">船端离线或 UDP remote 未知，无法向船控发送高电平指令。</p>
          <p v-if="cameraTriggerMessage" class="camera-ok">{{ cameraTriggerMessage }}</p>
          <p v-if="cameraTriggerError" class="camera-warning">{{ cameraTriggerError }}</p>
        </div>

        <div class="panel camera-card">
          <div class="camera-card__title">
            <strong>树莓派接口</strong>
            <button @click="loadCaptureStatus(captureMission.missionId)">刷新</button>
          </div>
          <dl class="camera-endpoints">
            <div>
              <dt>WebSocket</dt>
              <dd>ws://121.40.86.143:4100/api/pi/ws</dd>
            </div>
            <div>
              <dt>上传</dt>
              <dd>http://121.40.86.143:4100/api/captures/upload</dd>
            </div>
            <div>
              <dt>计划</dt>
              <dd>/api/capture-plan/current?deviceId={{ state.deviceId }}</dd>
            </div>
          </dl>
          <div class="ai-detection-toggle">
            <div>
              <strong>AI 识别过滤</strong>
              <span>{{ detectionSettings.enabled ? '上传后自动识别排口' : '仅保存原图' }}</span>
            </div>
            <button
              type="button"
              :class="{ active: detectionSettings.enabled }"
              :disabled="detectionSettingsLoading"
              @click="toggleDetectionSettings"
            >
              {{ detectionSettings.enabled ? '开' : '关' }}
            </button>
          </div>
          <p v-if="detectionSettingsError" class="camera-warning">{{ detectionSettingsError }}</p>
          <button :disabled="testPlanLoading" @click="createTestCapturePlan">
            {{ testPlanLoading ? '创建中' : '创建测试拍摄计划' }}
          </button>
          <p v-if="testPlanMessage" class="camera-ok">{{ testPlanMessage }}</p>
          <p v-if="testPlanError" class="camera-warning">{{ testPlanError }}</p>
          <button @click="openCaptureLogs">查看 capture 事件日志</button>
        </div>
      </div>

      <div class="panel camera-card">
        <div class="camera-card__title">
          <strong>拍摄计划与上传验收</strong>
          <span>{{ captureMission.points.length }} 个拍照点</span>
        </div>
        <div v-if="captureMission.points.length === 0" class="capture-empty">暂无拍摄计划。可创建测试拍摄计划，或上传包含拍照点的航线。</div>
        <div v-else class="camera-points">
          <div class="camera-point" v-for="point in captureMission.points" :key="capturePointKey(point)">
            <div class="camera-point__head">
              <div>
                <b>{{ capturePointTitle(point) }}</b>
                <span>等待 {{ point.plan.wait_seconds }} 秒 · {{ point.plan.lng.toFixed(7) }}, {{ point.plan.lat.toFixed(7) }}</span>
              </div>
              <em :class="{ complete: point.complete }">{{ point.complete ? 'complete' : point.plan.status }}</em>
            </div>
            <div class="camera-photo-grid">
              <div
                v-for="cell in capturePhotoCells(point)"
                :key="cell.photoIndex"
                class="camera-photo-cell"
                :class="{ received: cell.image }"
              >
                <span>photo={{ cell.photoIndex }}</span>
                <em v-if="cell.image" :class="detectionClass(cell.image)">{{ detectionLabel(cell.image) }}</em>
                <small v-if="cell.image" class="camera-photo-links">
                  <a :href="`/api/captures/${cell.image.id}/original`" target="_blank" rel="noreferrer">原图</a>
                  <a
                    v-if="cell.image.detection?.status === 'complete' && cell.image.detection.annotated_path"
                    :href="`/api/captures/${cell.image.id}/annotated`"
                    target="_blank"
                    rel="noreferrer"
                  >结果</a>
                </small>
              </div>
            </div>
            <p v-if="point.missing.length > 0">缺失：{{ point.missing.join(', ') }}；补传次数 {{ point.plan.reupload_attempts }}</p>
            <p v-else>照片完整；已收到 {{ point.received }}/{{ point.plan.expected_photo_count }}</p>
          </div>
        </div>
      </div>
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
        <label class="logs-search">
          <span>关键词</span>
          <input
            v-model.trim="logFilters.q"
            type="search"
            placeholder="搜索消息 / details / raw hex"
            @keydown.enter.prevent="loadLogs"
          />
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
