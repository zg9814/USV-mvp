import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export type EventLogInput = {
  occurredAt?: string;
  level: EventLevel;
  category: string;
  type: string;
  deviceId?: string | null;
  systemId?: number | null;
  componentId?: number | null;
  remoteAddress?: string | null;
  remotePort?: number | null;
  mode?: string | null;
  armed?: boolean | null;
  command?: number | null;
  result?: string | null;
  message: string;
  details?: Record<string, unknown> | null;
  rawHex?: string | null;
};

export type TelemetrySampleInput = {
  occurredAt?: string;
  deviceId?: string | null;
  systemId?: number | null;
  componentId?: number | null;
  remoteAddress?: string | null;
  remotePort?: number | null;
  mode?: string | null;
  armed?: boolean | null;
  voltage?: number | null;
  current?: number | null;
  batteryPercent?: number | null;
  gpsFixType?: number | null;
  gpsFixLabel?: string | null;
  gpsSatellites?: number | null;
  gpsHdop?: number | null;
  gpsVdop?: number | null;
  lat?: number | null;
  lng?: number | null;
  speed?: number | null;
  heading?: number | null;
};

export type EventLogQuery = {
  from?: string | null;
  to?: string | null;
  level?: string | null;
  category?: string | null;
  type?: string | null;
  q?: string | null;
  limit?: number | null;
  cursor?: number | null;
};

export type TelemetryQuery = {
  from?: string | null;
  to?: string | null;
  limit?: number | null;
  cursor?: number | null;
};

type EventLogRow = {
  id: number;
  occurred_at: string;
  level: string;
  category: string;
  type: string;
  device_id: string | null;
  system_id: number | null;
  component_id: number | null;
  remote_address: string | null;
  remote_port: number | null;
  mode: string | null;
  armed: number | null;
  command: number | null;
  result: string | null;
  message: string;
  details_json: string | null;
  raw_hex: string | null;
};

type TelemetryRow = {
  id: number;
  occurred_at: string;
  device_id: string | null;
  system_id: number | null;
  component_id: number | null;
  remote_address: string | null;
  remote_port: number | null;
  mode: string | null;
  armed: number | null;
  voltage: number | null;
  current: number | null;
  battery_percent: number | null;
  gps_fix_type: number | null;
  gps_fix_label: string | null;
  gps_satellites: number | null;
  gps_hdop: number | null;
  gps_vdop: number | null;
  lat: number | null;
  lng: number | null;
  speed: number | null;
  heading: number | null;
};

export class EventLogStore {
  private readonly db: Database.Database;
  private readonly retentionDays: number;
  private readonly insertEventStmt: Database.Statement;
  private readonly insertTelemetryStmt: Database.Statement;

  constructor(dbPath: string, retentionDays: number) {
    const resolvedPath = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });

    this.retentionDays = Math.max(1, Math.round(retentionDays));
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initializeSchema();

    this.insertEventStmt = this.db.prepare(`
      INSERT INTO event_logs (
        occurred_at, level, category, type, device_id, system_id, component_id,
        remote_address, remote_port, mode, armed, command, result, message,
        details_json, raw_hex
      ) VALUES (
        @occurred_at, @level, @category, @type, @device_id, @system_id, @component_id,
        @remote_address, @remote_port, @mode, @armed, @command, @result, @message,
        @details_json, @raw_hex
      )
    `);

    this.insertTelemetryStmt = this.db.prepare(`
      INSERT INTO telemetry_samples (
        occurred_at, device_id, system_id, component_id, remote_address, remote_port,
        mode, armed, voltage, current, battery_percent, gps_fix_type, gps_fix_label,
        gps_satellites, gps_hdop, gps_vdop, lat, lng, speed, heading
      ) VALUES (
        @occurred_at, @device_id, @system_id, @component_id, @remote_address, @remote_port,
        @mode, @armed, @voltage, @current, @battery_percent, @gps_fix_type, @gps_fix_label,
        @gps_satellites, @gps_hdop, @gps_vdop, @lat, @lng, @speed, @heading
      )
    `);
  }

  logEvent(input: EventLogInput): void {
    try {
      this.insertEventStmt.run({
        occurred_at: input.occurredAt ?? new Date().toISOString(),
        level: input.level,
        category: input.category,
        type: input.type,
        device_id: input.deviceId ?? null,
        system_id: input.systemId ?? null,
        component_id: input.componentId ?? null,
        remote_address: input.remoteAddress ?? null,
        remote_port: input.remotePort ?? null,
        mode: input.mode ?? null,
        armed: boolToInt(input.armed),
        command: input.command ?? null,
        result: input.result ?? null,
        message: input.message,
        details_json: input.details ? JSON.stringify(input.details) : null,
        raw_hex: input.rawHex ?? null
      });
    } catch (error) {
      console.warn(`event log write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logTelemetry(input: TelemetrySampleInput): void {
    try {
      this.insertTelemetryStmt.run({
        occurred_at: input.occurredAt ?? new Date().toISOString(),
        device_id: input.deviceId ?? null,
        system_id: input.systemId ?? null,
        component_id: input.componentId ?? null,
        remote_address: input.remoteAddress ?? null,
        remote_port: input.remotePort ?? null,
        mode: input.mode ?? null,
        armed: boolToInt(input.armed),
        voltage: finiteOrNull(input.voltage),
        current: finiteOrNull(input.current),
        battery_percent: finiteOrNull(input.batteryPercent),
        gps_fix_type: input.gpsFixType ?? null,
        gps_fix_label: input.gpsFixLabel ?? null,
        gps_satellites: input.gpsSatellites ?? null,
        gps_hdop: finiteOrNull(input.gpsHdop),
        gps_vdop: finiteOrNull(input.gpsVdop),
        lat: finiteOrNull(input.lat),
        lng: finiteOrNull(input.lng),
        speed: finiteOrNull(input.speed),
        heading: finiteOrNull(input.heading)
      });
    } catch (error) {
      console.warn(`telemetry log write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  queryEvents(query: EventLogQuery): { items: EventLogRow[]; nextCursor: number | null } {
    const params = normalizeQuery(query);
    const clauses = ['occurred_at >= @from', 'occurred_at <= @to'];
    const values: Record<string, string | number> = {
      from: params.from,
      to: params.to,
      limit: params.limit
    };

    if (params.level) {
      clauses.push('level = @level');
      values.level = params.level;
    }
    if (params.category) {
      clauses.push('category = @category');
      values.category = params.category;
    }
    if (params.type) {
      clauses.push('type = @type');
      values.type = params.type;
    }
    if (params.q) {
      clauses.push(`(
        message LIKE @q ESCAPE '\\' OR category LIKE @q ESCAPE '\\'
        OR type LIKE @q ESCAPE '\\' OR level LIKE @q ESCAPE '\\'
        OR COALESCE(device_id, '') LIKE @q ESCAPE '\\'
        OR COALESCE(remote_address, '') LIKE @q ESCAPE '\\'
        OR COALESCE(result, '') LIKE @q ESCAPE '\\'
        OR COALESCE(details_json, '') LIKE @q ESCAPE '\\'
        OR COALESCE(raw_hex, '') LIKE @q ESCAPE '\\'
      )`);
      values.q = `%${escapeLike(params.q)}%`;
    }
    if (params.cursor) {
      clauses.push('id < @cursor');
      values.cursor = params.cursor;
    }

    const rows = this.db.prepare(`
      SELECT * FROM event_logs
      WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC
      LIMIT @limit
    `).all(values) as EventLogRow[];

    return {
      items: rows,
      nextCursor: rows.length === params.limit ? rows[rows.length - 1]?.id ?? null : null
    };
  }

  queryTelemetry(query: TelemetryQuery): { items: TelemetryRow[]; nextCursor: number | null } {
    const params = normalizeTelemetryQuery(query);
    const clauses = ['occurred_at >= @from', 'occurred_at <= @to'];
    const values: Record<string, string | number> = {
      from: params.from,
      to: params.to,
      limit: params.limit
    };

    if (params.cursor) {
      clauses.push('id < @cursor');
      values.cursor = params.cursor;
    }

    const rows = this.db.prepare(`
      SELECT * FROM telemetry_samples
      WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC
      LIMIT @limit
    `).all(values) as TelemetryRow[];

    return {
      items: rows,
      nextCursor: rows.length === params.limit ? rows[rows.length - 1]?.id ?? null : null
    };
  }

  exportEventsCsv(query: EventLogQuery): string {
    const result = this.queryEvents({ ...query, limit: 50_000, cursor: null });
    return toCsv([
      'id', 'occurred_at', 'level', 'category', 'type', 'device_id', 'system_id',
      'component_id', 'remote_address', 'remote_port', 'mode', 'armed', 'command',
      'result', 'message', 'details_json', 'raw_hex'
    ], result.items);
  }

  exportTelemetryCsv(query: TelemetryQuery): string {
    const result = this.queryTelemetry({ ...query, limit: 50_000, cursor: null });
    return toCsv([
      'id', 'occurred_at', 'device_id', 'system_id', 'component_id', 'remote_address',
      'remote_port', 'mode', 'armed', 'voltage', 'current', 'battery_percent',
      'gps_fix_type', 'gps_fix_label', 'gps_satellites', 'gps_hdop', 'gps_vdop',
      'lat', 'lng', 'speed', 'heading'
    ], result.items);
  }

  cleanup(): void {
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare('DELETE FROM event_logs WHERE occurred_at < ?').run(cutoff);
      this.db.prepare('DELETE FROM telemetry_samples WHERE occurred_at < ?').run(cutoff);
    } catch (error) {
      console.warn(`event log cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    this.db.close();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        device_id TEXT,
        system_id INTEGER,
        component_id INTEGER,
        remote_address TEXT,
        remote_port INTEGER,
        mode TEXT,
        armed INTEGER,
        command INTEGER,
        result TEXT,
        message TEXT NOT NULL,
        details_json TEXT,
        raw_hex TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_event_logs_time ON event_logs (occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_filter ON event_logs (category, type, level, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_command ON event_logs (command, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS telemetry_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        device_id TEXT,
        system_id INTEGER,
        component_id INTEGER,
        remote_address TEXT,
        remote_port INTEGER,
        mode TEXT,
        armed INTEGER,
        voltage REAL,
        current REAL,
        battery_percent REAL,
        gps_fix_type INTEGER,
        gps_fix_label TEXT,
        gps_satellites INTEGER,
        gps_hdop REAL,
        gps_vdop REAL,
        lat REAL,
        lng REAL,
        speed REAL,
        heading REAL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_samples_time ON telemetry_samples (occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_telemetry_samples_device_time ON telemetry_samples (device_id, occurred_at DESC);
    `);
  }
}

function normalizeQuery(query: EventLogQuery) {
  const defaults = defaultRange();
  return {
    from: normalizeDate(query.from, defaults.from),
    to: normalizeDate(query.to, defaults.to),
    level: blankToNull(query.level),
    category: blankToNull(query.category),
    type: blankToNull(query.type),
    q: blankToNull(query.q),
    limit: clampLimit(query.limit),
    cursor: positiveIntOrNull(query.cursor)
  };
}

function normalizeTelemetryQuery(query: TelemetryQuery) {
  const defaults = defaultRange();
  return {
    from: normalizeDate(query.from, defaults.from),
    to: normalizeDate(query.to, defaults.to),
    limit: clampLimit(query.limit),
    cursor: positiveIntOrNull(query.cursor)
  };
}

function defaultRange(): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now - 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString()
  };
}

function normalizeDate(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function clampLimit(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 200;
  return Math.max(1, Math.min(1000, Math.round(value ?? 200)));
}

function positiveIntOrNull(value: number | null | undefined): number | null {
  if (!Number.isFinite(value ?? NaN)) return null;
  const parsed = Math.round(value ?? 0);
  return parsed > 0 ? parsed : null;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function boolToInt(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
  ].join('\r\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
