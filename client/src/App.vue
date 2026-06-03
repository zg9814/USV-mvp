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
  status: 'idle' | 'uploading' | 'active' | 'paused' | 'completed';
  waypoints: Waypoint[];
  currentWaypoint: number;
  totalWaypoints: number;
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
const planningEnabled = ref(true);
const mapLayerMode = ref<'vector' | 'satellite'>('vector');
const mission = reactive<MissionState>({
  status: 'idle',
  waypoints: [],
  currentWaypoint: 0,
  totalWaypoints: 0
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

let ws: WebSocket | null = null;
let controlTimer: number | null = null;
let reconnectTimer: number | null = null;
let mapContainer: HTMLDivElement | null = null;
let map: any = null;
let shipMarker: any = null;
let trackLine: any = null;
let routeLine: any = null;
let waypointMarkers: any[] = [];
let hasCenteredMap = false;
let satelliteLayer: any = null;
let satelliteLabelLayer: any = null;

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
const missionStatusLabel = computed(() => {
  const labels: Record<string, string> = { idle: '空闲', uploading: '上传中', active: '执行中', paused: '已暂停', completed: '已完成' };
  return labels[mission.status] || mission.status;
});
const modes = [
  { key: 'manual', label: '手动' },
  { key: 'hold', label: '保持' },
  { key: 'mission', label: '自动任务' },
  { key: 'rtl', label: '返航' },
  { key: 'posctl', label: '位置' },
  { key: 'stabilized', label: '增稳' }
];

watch(track, updateMapOverlays, { deep: true });
watch(waypoints, updateRouteOverlays, { deep: true });
watch(() => [state.lat, state.lng, state.heading, state.online], updateMapOverlays);

onMounted(() => {
  connectWs();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', zeroControl);
  initializeMap();
  controlTimer = window.setInterval(() => {
    pruneTrack();
    updateKeyboardControl();
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
      statusText.value = `已发送 ${message.data.action}`;
    }
    if (message.type === 'mission.current') {
      mission.currentWaypoint = message.data.seq;
    }
    if (message.type === 'mission.reached') {
      statusText.value = `到达航点 ${message.data.seq + 1}`;
    }
    if (message.type === 'mission.uploaded') {
      mission.status = message.data.success ? 'active' : 'idle';
      statusText.value = message.data.success ? '航线上传成功' : '航线上传失败';
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
      statusText.value = '航线已清除';
    }
  });

  ws.addEventListener('close', () => {
    wsConnected.value = false;
    statusText.value = 'WebSocket 断开，正在重连';
    reconnectTimer = window.setTimeout(connectWs, 1000);
  });
}

function send(type: string, data: unknown = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, data }));
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

function uploadMission() {
  if (waypoints.value.length === 0) return;
  mission.status = 'uploading';
  mission.waypoints = [...waypoints.value];
  mission.currentWaypoint = 0;
  mission.totalWaypoints = waypoints.value.length;
  send('mission.upload', { waypoints: waypoints.value });
}

function pauseMission() {
  send('mission.pause');
}

function resumeMission() {
  send('mission.resume');
}

function clearMission() {
  send('mission.clear');
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
  mapContainer = el;
  initializeMap();
}

function loadTianditu() {
  if (window.T) return Promise.resolve(window.T);

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api.tianditu.gov.cn/api?v=4.0&tk=${TIANDITU_KEY}`;
    script.async = true;
    script.onload = () => {
      if (window.T) {
        mapStatusText.value = '天地图已加载';
        resolve(window.T);
      } else {
        mapStatusText.value = '天地图加载失败';
        reject(new Error('天地图加载失败'));
      }
    };
    script.onerror = () => {
      mapStatusText.value = '天地图脚本加载失败';
      reject(new Error('天地图加载失败'));
    };
    document.head.appendChild(script);
  });
}

async function initializeMap() {
  if (!mapContainer || map) return;

  try {
    await loadTianditu();
  } catch (error) {
    console.error(error);
    return;
  }

  const T = window.T;
  map = new T.Map(mapContainer);
  map.centerAndZoom(new T.LngLat(121.04708, 31.2792), 16);

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

  map.addEventListener('click', handleMapClick);
  showDebugShipMarker();
  updateMapOverlays();
  updateRouteOverlays();
}

function setMapLayer(mode: 'vector' | 'satellite') {
  mapLayerMode.value = mode;
  updateMapLayers();
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

  if (!shipMarker) {
    const icon = new T.Icon({
      iconUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230f766e"><circle cx="12" cy="12" r="10"/><polygon points="12,2 18,18 12,14 6,18" fill="white"/></svg>'),
      iconSize: new T.Point(38, 38),
      iconAnchor: new T.Point(19, 19)
    });
    shipMarker = new T.Marker(position, { icon });
    map.addOverLay(shipMarker);
  } else {
    shipMarker.setLngLat(position);
  }

  shipOverlay.visible = false;
  shipOverlay.heading = state.heading ?? 0;
  shipOverlay.online = state.online;

  displayTrack.value = track.value.map((p) => ({ lng: p.lng, lat: p.lat }));
  trackLine?.setLngLats(displayTrack.value.map((p) => new T.LngLat(p.lng, p.lat)));

  if (!hasCenteredMap) {
    map.centerAndZoom(position, 17);
    hasCenteredMap = true;
  }
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
  waypointMarkers = waypoints.value.map((point) => {
    const marker = new T.Marker(new T.LngLat(point.lng, point.lat));
    marker.bindInfoWindow(new T.InfoWindow(`<div class="waypoint-marker">${point.order}</div>`, { offset: new T.Point(0, 0) }));
    return marker;
  });
  for (const marker of waypointMarkers) map.addOverLay(marker);
}

function handleMapClick(event: any) {
  if (!planningEnabled.value || !event.lnglat) return;
  const lnglat = event.lnglat || event.lngLat;
  if (!lnglat) return;
  waypoints.value = [
    ...waypoints.value,
    {
      lng: lnglat.lng || lnglat.getLng(),
      lat: lnglat.lat || lnglat.getLat(),
      order: waypoints.value.length + 1
    }
  ];
}

function undoWaypoint() {
  waypoints.value = waypoints.value.slice(0, -1).map((point, index) => ({ ...point, order: index + 1 }));
}

function clearWaypoints() {
  waypoints.value = [];
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

</script>

<template>
  <main class="shell">
    <section class="topbar">
      <div>
        <p class="eyebrow">USV Cloud MVP</p>
        <h1>{{ state.deviceId }}</h1>
      </div>
      <div class="status-pills">
        <span class="pill" :class="{ ok: wsConnected }">WS {{ wsConnected ? '连接' : '断开' }}</span>
        <span class="pill" :class="{ ok: state.online }">船端 {{ state.online ? '在线' : '离线' }}</span>
        <span class="pill" :class="{ ok: state.remoteKnown }">UDP {{ state.udpPort }}</span>
      </div>
    </section>

    <section class="layout">
      <div class="map-panel">
        <div :ref="bindMap" class="amap"></div>
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
          <span class="map-badge">{{ coordinateModeLabel }}</span>
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
                (航点 {{ mission.currentWaypoint + 1 }}/{{ mission.totalWaypoints }})
              </span>
            </div>
            <div class="mission-buttons">
              <button v-if="mission.status === 'idle'" @click="uploadMission" :disabled="waypoints.length === 0">
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
              <button v-for="mode in modes" :key="mode.key" @click="setMode(mode.key)">
                {{ mode.label }}
              </button>
            </div>
          </div>

          <div class="buttons">
            <button @click="command('control.arm')">解锁</button>
            <button @click="command('control.disarm')">上锁</button>
            <button class="danger" @click="command('control.emergencyStop')">急停</button>
          </div>

          <div class="joystick-panel">
            <div
              class="joystick"
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
            <div class="joystick-readout">
              <span>油门 {{ throttle.toFixed(2) }}</span>
              <span>转向 {{ steering.toFixed(2) }}</span>
            </div>
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
  </main>
</template>
