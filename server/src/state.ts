import type { RemoteEndpoint, UsvState, MissionState, MissionItem } from './types.js';

export class UsvStore {
  private state: UsvState = {
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
    remote: null
  };

  private mission: MissionState = {
    status: 'idle',
    waypoints: [],
    currentWaypoint: 0,
    totalWaypoints: 0
  };

  constructor(private readonly offlineAfterMs: number) {}

  getState(): UsvState {
    this.refreshOnline();
    return { ...this.state, remote: this.state.remote ? { ...this.state.remote } : null };
  }

  markSeen(systemId: number, componentId: number, remote: RemoteEndpoint): UsvState {
    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      deviceId: `USV-SYS-${systemId}`,
      systemId,
      componentId,
      online: true,
      lastSeen: now,
      remote
    };
    return this.getState();
  }

  patch(update: Partial<Omit<UsvState, 'remote'>>): UsvState {
    this.state = { ...this.state, ...update };
    return this.getState();
  }

  canControl(): boolean {
    const state = this.getState();
    return state.online && state.remote !== null && state.systemId > 0;
  }

  private refreshOnline(): void {
    if (!this.state.lastSeen) {
      this.state.online = false;
      return;
    }
    this.state.online = Date.now() - Date.parse(this.state.lastSeen) <= this.offlineAfterMs;
  }

  // ==================== 航线管理 ====================

  getMissionState(): MissionState {
    return { ...this.mission };
  }

  setMissionWaypoints(waypoints: MissionItem[]): void {
    this.mission = {
      status: 'idle',
      waypoints,
      currentWaypoint: 0,
      totalWaypoints: waypoints.length
    };
  }

  setMissionStatus(status: MissionState['status']): void {
    this.mission.status = status;
  }

  setCurrentWaypoint(seq: number): void {
    this.mission.currentWaypoint = seq;
  }

  clearMission(): void {
    this.mission = {
      status: 'idle',
      waypoints: [],
      currentWaypoint: 0,
      totalWaypoints: 0
    };
  }
}
