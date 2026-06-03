export type RemoteEndpoint = {
  address: string;
  port: number;
};

export type UsvState = {
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
  remote: RemoteEndpoint | null;
};

export type ManualControlInput = {
  throttle: number;
  steering: number;
};

export type Waypoint = {
  lat: number;
  lng: number;
  order: number;
};

export type MissionState = {
  status: 'idle' | 'uploading' | 'active' | 'paused' | 'completed';
  waypoints: Waypoint[];
  currentWaypoint: number;
  totalWaypoints: number;
};
