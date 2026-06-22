import Database from 'better-sqlite3';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ReadStream } from 'node:fs';

export type CapturePlanInput = {
  missionId: string;
  deviceId: string;
  capturePointIndex: number;
  waypointSeq: number;
  lat: number;
  lng: number;
  waitSeconds: number;
  expectedPhotoCount: number;
  captureStepDeg: number;
  captureDate?: string;
  pointIndex?: number;
};

export type DailyCapturePointInput = {
  deviceId: string;
  captureDate: string;
  pointIndex: number;
  lat?: number;
  lng?: number;
  waitSeconds?: number;
  expectedPhotoCount?: number;
  captureStepDeg?: number;
};

export type CaptureImageInput = {
  missionId: string;
  deviceId: string;
  capturePointIndex: number;
  photoIndex: number;
  angleDeg: number | null;
  takenAt: string | null;
  filePath: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  captureDate?: string;
  pointIndex?: number;
};

export type DailyCaptureImageInput = {
  deviceId: string;
  captureDate: string;
  pointIndex: number;
  photoIndex: number;
  angleDeg: number | null;
  takenAt: string | null;
  filePath: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number;
};

export type CaptureStatusInput = {
  missionId?: string;
  deviceId: string;
  capturePointIndex?: number;
  captureDate?: string;
  pointIndex?: number;
  status: string;
};

export type CapturePlanRow = {
  id: number;
  mission_id: string;
  device_id: string;
  capture_point_index: number;
  point_index: number | null;
  capture_date: string | null;
  waypoint_seq: number;
  lat: number;
  lng: number;
  wait_seconds: number;
  expected_photo_count: number;
  capture_step_deg: number;
  reupload_attempts: number;
  status: string;
  first_activity_at: string | null;
  last_check_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CaptureImageRow = {
  id: number;
  mission_id: string;
  device_id: string;
  capture_point_index: number;
  point_index: number | null;
  capture_date: string | null;
  photo_index: number;
  angle_deg: number | null;
  taken_at: string | null;
  file_path: string;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  uploaded_at: string;
  detection?: CaptureDetectionRow | null;
};

export type CaptureDetectionRow = {
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

export type CapturePointStatus = {
  plan: CapturePlanRow;
  images: CaptureImageRow[];
  received: number;
  missing: number[];
  complete: boolean;
};

export class CaptureStore {
  private readonly db: Database.Database;
  private readonly dataDir: string;

  constructor(dbPath: string, dataDir = 'data/captures') {
    const resolvedPath = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });
    this.dataDir = resolve(dataDir);
    mkdirSync(this.originalRoot(), { recursive: true });
    mkdirSync(this.annotatedRoot(), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initializeSchema();
  }

  savePlan(missionId: string, plans: CapturePlanInput[]): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM capture_plans WHERE mission_id = ?').run(missionId);
      const stmt = this.db.prepare(`
        INSERT INTO capture_plans (
          mission_id, device_id, capture_point_index, point_index, capture_date,
          waypoint_seq, lat, lng, wait_seconds, expected_photo_count,
          capture_step_deg, status, created_at, updated_at
        ) VALUES (
          @missionId, @deviceId, @capturePointIndex, @pointIndex, @captureDate,
          @waypointSeq, @lat, @lng, @waitSeconds, @expectedPhotoCount,
          @captureStepDeg, 'planned', @now, @now
        )
      `);
      for (const plan of plans) {
        stmt.run({
          ...plan,
          pointIndex: plan.pointIndex ?? plan.capturePointIndex,
          captureDate: plan.captureDate ?? null,
          now
        });
      }
    });
    tx();
  }

  ensurePlan(plan: CapturePlanInput): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO capture_plans (
        mission_id, device_id, capture_point_index, point_index, capture_date,
        waypoint_seq, lat, lng, wait_seconds, expected_photo_count,
        capture_step_deg, status, created_at, updated_at
      ) VALUES (
        @missionId, @deviceId, @capturePointIndex, @pointIndex, @captureDate,
        @waypointSeq, @lat, @lng, @waitSeconds, @expectedPhotoCount,
        @captureStepDeg, 'receiving', @now, @now
      )
      ON CONFLICT(mission_id, capture_point_index) DO UPDATE SET
        expected_photo_count = MAX(expected_photo_count, excluded.expected_photo_count),
        point_index = COALESCE(capture_plans.point_index, excluded.point_index),
        capture_date = COALESCE(capture_plans.capture_date, excluded.capture_date),
        updated_at = excluded.updated_at
    `).run({
      ...plan,
      pointIndex: plan.pointIndex ?? plan.capturePointIndex,
      captureDate: plan.captureDate ?? null,
      now
    });
  }

  ensureDailyPoint(input: DailyCapturePointInput): CapturePointStatus {
    const now = new Date().toISOString();
    const existing = this.getDailyPlan(input.deviceId, input.captureDate, input.pointIndex);
    const payload = {
      missionId: dailyMissionId(input.deviceId, input.captureDate),
      deviceId: input.deviceId,
      capturePointIndex: input.pointIndex,
      pointIndex: input.pointIndex,
      captureDate: input.captureDate,
      waypointSeq: input.pointIndex,
      lat: input.lat ?? 0,
      lng: input.lng ?? 0,
      waitSeconds: input.waitSeconds ?? 60,
      expectedPhotoCount: input.expectedPhotoCount ?? 10,
      captureStepDeg: input.captureStepDeg ?? 36,
      now
    };

    if (existing) {
      this.db.prepare(`
        UPDATE capture_plans
        SET expected_photo_count = MAX(expected_photo_count, @expectedPhotoCount),
            capture_step_deg = @captureStepDeg,
            updated_at = @now
        WHERE id = @id
      `).run({ id: existing.id, ...payload });
      return this.statusForPlan(this.getPlanById(existing.id) ?? existing);
    }

    const result = this.db.prepare(`
      INSERT INTO capture_plans (
        mission_id, device_id, capture_point_index, point_index, capture_date,
        waypoint_seq, lat, lng, wait_seconds, expected_photo_count,
        capture_step_deg, status, created_at, updated_at
      ) VALUES (
        @missionId, @deviceId, @capturePointIndex, @pointIndex, @captureDate,
        @waypointSeq, @lat, @lng, @waitSeconds, @expectedPhotoCount,
        @captureStepDeg, 'receiving', @now, @now
      )
    `).run(payload);
    return this.statusForPlan(this.getPlanById(Number(result.lastInsertRowid)) as CapturePlanRow);
  }

  getPlan(missionId: string): CapturePlanRow[] {
    return this.db.prepare(`
      SELECT * FROM capture_plans WHERE mission_id = ? ORDER BY capture_point_index ASC
    `).all(missionId) as CapturePlanRow[];
  }

  getCurrentPlan(deviceId?: string | null): { missionId: string | null; plans: CapturePlanRow[] } {
    const row = this.db.prepare(`
      SELECT mission_id FROM capture_plans
      ${deviceId ? 'WHERE device_id = @deviceId' : ''}
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get({ deviceId }) as { mission_id: string } | undefined;
    if (!row) return { missionId: null, plans: [] };
    return { missionId: row.mission_id, plans: this.getPlan(row.mission_id) };
  }

  getCurrentCapture(deviceId?: string | null, captureDate?: string | null): {
    missionId: string | null;
    captureDate: string | null;
    deviceId: string | null;
    points: CapturePointStatus[];
  } {
    const params = { deviceId, captureDate };
    const where = [
      'capture_date IS NOT NULL',
      deviceId ? 'device_id = @deviceId' : '',
      captureDate ? 'capture_date = @captureDate' : ''
    ].filter(Boolean).join(' AND ');
    const latest = this.db.prepare(`
      SELECT device_id, capture_date FROM capture_plans
      WHERE ${where}
      ORDER BY capture_date DESC, point_index DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(params) as { device_id: string; capture_date: string } | undefined;

    if (latest) return this.getDailyStatus(latest.device_id, latest.capture_date);

    const current = this.getCurrentPlan(deviceId);
    return {
      missionId: current.missionId,
      captureDate: null,
      deviceId: deviceId ?? null,
      points: current.plans.map((plan) => this.statusForPlan(plan))
    };
  }

  getDailyStatus(deviceId: string, captureDate: string): {
    missionId: string | null;
    captureDate: string;
    deviceId: string;
    points: CapturePointStatus[];
  } {
    const plans = this.db.prepare(`
      SELECT * FROM capture_plans
      WHERE device_id = ? AND capture_date = ?
      ORDER BY point_index ASC
    `).all(deviceId, captureDate) as CapturePlanRow[];
    return {
      missionId: null,
      captureDate,
      deviceId,
      points: plans.map((plan) => this.statusForPlan(plan))
    };
  }

  markActivity(input: CaptureStatusInput): CapturePointStatus | null {
    const now = new Date().toISOString();
    if (input.captureDate && input.pointIndex) {
      const plan = this.getDailyPlan(input.deviceId, input.captureDate, input.pointIndex);
      if (!plan) return null;
      this.db.prepare(`
        UPDATE capture_plans
        SET status = @status,
            first_activity_at = COALESCE(first_activity_at, @now),
            updated_at = @now
        WHERE id = @id
      `).run({ id: plan.id, status: input.status, now });
      return this.getDailyPointStatus(input.deviceId, input.captureDate, input.pointIndex);
    }

    if (!input.missionId || !input.capturePointIndex) return null;
    this.db.prepare(`
      UPDATE capture_plans
      SET status = @status,
          first_activity_at = COALESCE(first_activity_at, @now),
          updated_at = @now
      WHERE mission_id = @missionId AND device_id = @deviceId AND capture_point_index = @capturePointIndex
    `).run({ ...input, now });
    return this.getPointStatus(input.missionId, input.capturePointIndex);
  }

  insertImage(input: CaptureImageInput): CapturePointStatus | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO capture_images (
        mission_id, device_id, capture_point_index, point_index, capture_date,
        photo_index, angle_deg, taken_at, file_path, original_name,
        mime_type, size_bytes, uploaded_at
      ) VALUES (
        @missionId, @deviceId, @capturePointIndex, @pointIndex, @captureDate,
        @photoIndex, @angleDeg, @takenAt, @filePath, @originalName,
        @mimeType, @sizeBytes, @now
      )
      ON CONFLICT(mission_id, capture_point_index, photo_index) DO UPDATE SET
        point_index = COALESCE(capture_images.point_index, excluded.point_index),
        capture_date = COALESCE(capture_images.capture_date, excluded.capture_date),
        angle_deg = excluded.angle_deg,
        taken_at = excluded.taken_at,
        file_path = excluded.file_path,
        original_name = excluded.original_name,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        uploaded_at = excluded.uploaded_at
    `).run({
      ...input,
      pointIndex: input.pointIndex ?? input.capturePointIndex,
      captureDate: input.captureDate ?? null,
      now
    });
    this.touchPlan(input.missionId, input.capturePointIndex, now);
    const status = this.getPointStatus(input.missionId, input.capturePointIndex);
    if (status?.complete) this.setPointStatus(input.missionId, input.capturePointIndex, 'complete');
    return this.getPointStatus(input.missionId, input.capturePointIndex);
  }

  insertDailyImage(input: DailyCaptureImageInput): CapturePointStatus {
    const now = new Date().toISOString();
    this.ensureDailyPoint({
      deviceId: input.deviceId,
      captureDate: input.captureDate,
      pointIndex: input.pointIndex,
      expectedPhotoCount: Math.max(10, input.photoIndex),
      captureStepDeg: 36
    });
    const plan = this.getDailyPlan(input.deviceId, input.captureDate, input.pointIndex);
    if (!plan) throw new Error('daily capture point not found');
    const existing = this.db.prepare(`
      SELECT id FROM capture_images
      WHERE device_id = ? AND capture_date = ? AND point_index = ? AND photo_index = ?
    `).get(input.deviceId, input.captureDate, input.pointIndex, input.photoIndex) as { id: number } | undefined;

    const payload = {
      missionId: dailyMissionId(input.deviceId, input.captureDate),
      capturePointIndex: input.pointIndex,
      ...input,
      now
    };

    if (existing) {
      this.db.prepare(`
        UPDATE capture_images
        SET mission_id = @missionId,
            capture_point_index = @capturePointIndex,
            angle_deg = @angleDeg,
            taken_at = @takenAt,
            file_path = @filePath,
            original_name = @originalName,
            mime_type = @mimeType,
            size_bytes = @sizeBytes,
            uploaded_at = @now
        WHERE id = @id
      `).run({ id: existing.id, ...payload });
    } else {
      this.db.prepare(`
        INSERT INTO capture_images (
          mission_id, device_id, capture_point_index, point_index, capture_date,
          photo_index, angle_deg, taken_at, file_path, original_name,
          mime_type, size_bytes, uploaded_at
        ) VALUES (
          @missionId, @deviceId, @capturePointIndex, @pointIndex, @captureDate,
          @photoIndex, @angleDeg, @takenAt, @filePath, @originalName,
          @mimeType, @sizeBytes, @now
        )
      `).run(payload);
    }

    this.db.prepare(`
      UPDATE capture_plans
      SET first_activity_at = COALESCE(first_activity_at, @now),
          status = CASE WHEN status = 'planned' THEN 'receiving' ELSE status END,
          updated_at = @now
      WHERE id = @id
    `).run({ id: plan.id, now });
    const status = this.getDailyPointStatus(input.deviceId, input.captureDate, input.pointIndex) as CapturePointStatus;
    this.setDailyPointStatus(input.deviceId, input.captureDate, input.pointIndex, status.complete ? 'complete' : 'receiving');
    return this.getDailyPointStatus(input.deviceId, input.captureDate, input.pointIndex) as CapturePointStatus;
  }

  getDailyImage(deviceId: string, captureDate: string, pointIndex: number, photoIndex: number): CaptureImageRow | null {
    const row = this.db.prepare(`
      SELECT * FROM capture_images
      WHERE device_id = ? AND capture_date = ? AND point_index = ? AND photo_index = ?
    `).get(deviceId, captureDate, pointIndex, photoIndex) as CaptureImageRow | undefined;
    return row ? this.withDetection(row) : null;
  }

  queueDetection(imageId: number, modelPath: string): CaptureDetectionRow {
    const now = new Date().toISOString();
    const existing = this.getDetection(imageId);
    if (existing) {
      this.db.prepare(`
        UPDATE capture_detections
        SET status = 'pending',
            model_path = @modelPath,
            device = NULL,
            inference_ms = NULL,
            detections_json = NULL,
            detected_count = 0,
            annotated_path = NULL,
            error_message = NULL,
            updated_at = @now
        WHERE image_id = @imageId
      `).run({ imageId, modelPath, now });
    } else {
      this.db.prepare(`
        INSERT INTO capture_detections (
          image_id, status, model_path, detected_count, created_at, updated_at
        ) VALUES (
          @imageId, 'pending', @modelPath, 0, @now, @now
        )
      `).run({ imageId, modelPath, now });
    }
    return this.getDetection(imageId) as CaptureDetectionRow;
  }

  skipDetection(imageId: number): CaptureDetectionRow {
    const now = new Date().toISOString();
    const existing = this.getDetection(imageId);
    if (existing) {
      this.db.prepare(`
        UPDATE capture_detections
        SET status = 'skipped',
            model_path = NULL,
            device = NULL,
            inference_ms = NULL,
            detections_json = NULL,
            detected_count = 0,
            annotated_path = NULL,
            error_message = NULL,
            updated_at = @now
        WHERE image_id = @imageId
      `).run({ imageId, now });
    } else {
      this.db.prepare(`
        INSERT INTO capture_detections (
          image_id, status, detected_count, created_at, updated_at
        ) VALUES (
          @imageId, 'skipped', 0, @now, @now
        )
      `).run({ imageId, now });
    }
    return this.getDetection(imageId) as CaptureDetectionRow;
  }

  getDetection(imageId: number): CaptureDetectionRow | null {
    const row = this.db.prepare('SELECT * FROM capture_detections WHERE image_id = ?')
      .get(imageId) as CaptureDetectionRow | undefined;
    return row ?? null;
  }

  listPendingDetections(limit = 10): CaptureDetectionRow[] {
    return this.db.prepare(`
      SELECT * FROM capture_detections
      WHERE status = 'pending'
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(limit) as CaptureDetectionRow[];
  }

  markDetectionRunning(imageId: number, device: string | null): CaptureDetectionRow | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE capture_detections
      SET status = 'running',
          device = @device,
          error_message = NULL,
          updated_at = @now
      WHERE image_id = @imageId
    `).run({ imageId, device, now });
    return this.getDetection(imageId);
  }

  markDetectionComplete(input: {
    imageId: number;
    modelPath: string;
    device: string | null;
    inferenceMs: number | null;
    detectionsJson: string;
    detectedCount: number;
    annotatedPath: string;
  }): CaptureDetectionRow | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE capture_detections
      SET status = 'complete',
          model_path = @modelPath,
          device = @device,
          inference_ms = @inferenceMs,
          detections_json = @detectionsJson,
          detected_count = @detectedCount,
          annotated_path = @annotatedPath,
          error_message = NULL,
          updated_at = @now
      WHERE image_id = @imageId
    `).run({ ...input, now });
    return this.getDetection(input.imageId);
  }

  markDetectionFailed(imageId: number, errorMessage: string): CaptureDetectionRow | null {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE capture_detections
      SET status = 'failed',
          error_message = @errorMessage,
          updated_at = @now
      WHERE image_id = @imageId
    `).run({ imageId, errorMessage, now });
    return this.getDetection(imageId);
  }

  getMissionStatus(missionId: string): { missionId: string; points: CapturePointStatus[] } {
    const plans = this.getPlan(missionId);
    return { missionId, points: plans.map((plan) => this.statusForPlan(plan)) };
  }

  getPointStatus(missionId: string, capturePointIndex: number): CapturePointStatus | null {
    const plan = this.db.prepare(`
      SELECT * FROM capture_plans WHERE mission_id = ? AND capture_point_index = ?
    `).get(missionId, capturePointIndex) as CapturePlanRow | undefined;
    return plan ? this.statusForPlan(plan) : null;
  }

  getDailyPointStatus(deviceId: string, captureDate: string, pointIndex: number): CapturePointStatus | null {
    const plan = this.getDailyPlan(deviceId, captureDate, pointIndex);
    return plan ? this.statusForPlan(plan) : null;
  }

  listDueChecks(delaySeconds: number, maxAttempts: number): CapturePointStatus[] {
    const cutoff = new Date(Date.now() - delaySeconds * 1000).toISOString();
    const plans = this.db.prepare(`
      SELECT * FROM capture_plans
      WHERE first_activity_at IS NOT NULL
        AND first_activity_at <= @cutoff
        AND reupload_attempts < @maxAttempts
        AND status NOT IN ('complete', 'incomplete')
        AND (last_check_at IS NULL OR last_check_at <= @cutoff)
      ORDER BY first_activity_at ASC
      LIMIT 20
    `).all({ cutoff, maxAttempts }) as CapturePlanRow[];
    return plans.map((plan) => this.statusForPlan(plan)).filter((status) => !status.complete);
  }

  recordReuploadAttempt(plan: CapturePlanRow): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE capture_plans
      SET reupload_attempts = reupload_attempts + 1,
          last_check_at = @now,
          status = 'reupload_requested',
          updated_at = @now
      WHERE id = @id
    `).run({ id: plan.id, now });
  }

  markIncompleteAfterMax(maxAttempts: number): CapturePointStatus[] {
    const plans = this.db.prepare(`
      SELECT * FROM capture_plans
      WHERE reupload_attempts >= @maxAttempts AND status NOT IN ('complete', 'incomplete')
    `).all({ maxAttempts }) as CapturePlanRow[];
    const incomplete = plans.map((plan) => this.statusForPlan(plan)).filter((status) => !status.complete);
    for (const status of incomplete) this.setStatusById(status.plan.id, 'incomplete');
    return incomplete;
  }

  setPointStatus(missionId: string, capturePointIndex: number, status: string): void {
    this.db.prepare(`
      UPDATE capture_plans SET status = ?, updated_at = ? WHERE mission_id = ? AND capture_point_index = ?
    `).run(status, new Date().toISOString(), missionId, capturePointIndex);
  }

  setDailyPointStatus(deviceId: string, captureDate: string, pointIndex: number, status: string): void {
    this.db.prepare(`
      UPDATE capture_plans
      SET status = ?, updated_at = ?
      WHERE device_id = ? AND capture_date = ? AND point_index = ?
    `).run(status, new Date().toISOString(), deviceId, captureDate, pointIndex);
  }

  getImage(id: number): CaptureImageRow | null {
    const row = this.db.prepare('SELECT * FROM capture_images WHERE id = ?').get(id) as CaptureImageRow | undefined;
    return row ? this.withDetection(row) : null;
  }

  openImage(id: number): { row: CaptureImageRow; stream: ReadStream } | null {
    const row = this.getImage(id);
    if (!row) return null;
    return { row, stream: createReadStream(row.file_path) };
  }

  openAnnotatedImage(id: number): { row: CaptureImageRow; detection: CaptureDetectionRow; stream: ReadStream } | null {
    const row = this.getImage(id);
    const detection = row?.detection;
    if (!row || !detection || detection.status !== 'complete' || !detection.annotated_path) return null;
    if (!existsSync(detection.annotated_path)) return null;
    return { row, detection, stream: createReadStream(detection.annotated_path) };
  }

  makeImagePath(missionId: string, capturePointIndex: number, photoIndex: number, originalName: string | null): string {
    const safeMission = sanitizePathPart(missionId);
    const safePoint = sanitizePathPart(String(capturePointIndex));
    const ext = safeExtension(originalName);
    const dir = join(this.originalRoot(), safeMission, safePoint);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${String(photoIndex).padStart(3, '0')}${ext}`);
  }

  makeDailyImagePath(deviceId: string, captureDate: string, pointIndex: number, photoIndex: number, originalName: string | null): string {
    const ext = safeExtension(originalName);
    const dir = join(
      this.originalRoot(),
      sanitizePathPart(deviceId),
      sanitizePathPart(captureDate),
      sanitizePathPart(String(pointIndex))
    );
    mkdirSync(dir, { recursive: true });
    return join(dir, `${String(photoIndex).padStart(3, '0')}${ext}`);
  }

  makeAnnotatedImagePath(image: CaptureImageRow): string {
    const date = image.capture_date ?? 'mission';
    const point = image.point_index ?? image.capture_point_index;
    const dir = join(
      this.annotatedRoot(),
      sanitizePathPart(image.device_id),
      sanitizePathPart(date),
      sanitizePathPart(String(point))
    );
    mkdirSync(dir, { recursive: true });
    return join(dir, `${String(image.photo_index).padStart(3, '0')}_detected.jpg`);
  }

  close(): void {
    this.db.close();
  }

  private statusForPlan(plan: CapturePlanRow): CapturePointStatus {
    const images = plan.capture_date && plan.point_index
      ? this.db.prepare(`
          SELECT * FROM capture_images
          WHERE device_id = ? AND capture_date = ? AND point_index = ?
          ORDER BY photo_index ASC
        `).all(plan.device_id, plan.capture_date, plan.point_index) as CaptureImageRow[]
      : this.db.prepare(`
          SELECT * FROM capture_images
          WHERE mission_id = ? AND capture_point_index = ?
          ORDER BY photo_index ASC
        `).all(plan.mission_id, plan.capture_point_index) as CaptureImageRow[];
    const imagesWithDetections = images.map((image) => this.withDetection(image));
    const seen = new Set(imagesWithDetections.map((image) => image.photo_index));
    const missing: number[] = [];
    for (let index = 1; index <= plan.expected_photo_count; index += 1) {
      if (!seen.has(index)) missing.push(index);
    }
    return {
      plan,
      images: imagesWithDetections,
      received: seen.size,
      missing,
      complete: missing.length === 0
    };
  }

  private withDetection(image: CaptureImageRow): CaptureImageRow {
    return {
      ...image,
      detection: this.getDetection(image.id)
    };
  }

  private originalRoot(): string {
    return join(this.dataDir, 'original');
  }

  private annotatedRoot(): string {
    return join(this.dataDir, 'annotated');
  }

  private getDailyPlan(deviceId: string, captureDate: string, pointIndex: number): CapturePlanRow | null {
    const row = this.db.prepare(`
      SELECT * FROM capture_plans
      WHERE device_id = ? AND capture_date = ? AND point_index = ?
    `).get(deviceId, captureDate, pointIndex) as CapturePlanRow | undefined;
    return row ?? null;
  }

  private getPlanById(id: number): CapturePlanRow | null {
    const row = this.db.prepare('SELECT * FROM capture_plans WHERE id = ?').get(id) as CapturePlanRow | undefined;
    return row ?? null;
  }

  private setStatusById(id: number, status: string): void {
    this.db.prepare('UPDATE capture_plans SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  private touchPlan(missionId: string, capturePointIndex: number, now: string): void {
    this.db.prepare(`
      UPDATE capture_plans
      SET first_activity_at = COALESCE(first_activity_at, @now),
          status = CASE WHEN status = 'planned' THEN 'receiving' ELSE status END,
          updated_at = @now
      WHERE mission_id = @missionId AND capture_point_index = @capturePointIndex
    `).run({ missionId, capturePointIndex, now });
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capture_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        capture_point_index INTEGER NOT NULL,
        waypoint_seq INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        wait_seconds INTEGER NOT NULL,
        expected_photo_count INTEGER NOT NULL,
        capture_step_deg INTEGER NOT NULL,
        reupload_attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'planned',
        first_activity_at TEXT,
        last_check_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(mission_id, capture_point_index)
      );

      CREATE TABLE IF NOT EXISTS capture_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        capture_point_index INTEGER NOT NULL,
        photo_index INTEGER NOT NULL,
        angle_deg REAL,
        taken_at TEXT,
        file_path TEXT NOT NULL,
        original_name TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        uploaded_at TEXT NOT NULL,
        UNIQUE(mission_id, capture_point_index, photo_index)
      );

      CREATE TABLE IF NOT EXISTS capture_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL,
        model_path TEXT,
        device TEXT,
        inference_ms REAL,
        detections_json TEXT,
        detected_count INTEGER NOT NULL DEFAULT 0,
        annotated_path TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing('capture_plans', 'capture_date', 'TEXT');
    this.addColumnIfMissing('capture_plans', 'point_index', 'INTEGER');
    this.addColumnIfMissing('capture_images', 'capture_date', 'TEXT');
    this.addColumnIfMissing('capture_images', 'point_index', 'INTEGER');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_capture_plans_mission ON capture_plans (mission_id, capture_point_index);
      CREATE INDEX IF NOT EXISTS idx_capture_plans_device ON capture_plans (device_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_plans_daily_unique
        ON capture_plans (device_id, capture_date, point_index)
        WHERE capture_date IS NOT NULL AND point_index IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_capture_plans_daily
        ON capture_plans (device_id, capture_date, point_index);
      CREATE INDEX IF NOT EXISTS idx_capture_images_mission
        ON capture_images (mission_id, capture_point_index, photo_index);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_images_daily_unique
        ON capture_images (device_id, capture_date, point_index, photo_index)
        WHERE capture_date IS NOT NULL AND point_index IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_capture_images_daily
        ON capture_images (device_id, capture_date, point_index, photo_index);
      CREATE INDEX IF NOT EXISTS idx_capture_detections_status
        ON capture_detections (status, updated_at DESC);
    `);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((existing) => existing.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown';
}

function safeExtension(name: string | null): string {
  const match = name?.match(/\.[a-zA-Z0-9]{1,8}$/);
  return match ? match[0].toLowerCase() : '.jpg';
}

function dailyMissionId(deviceId: string, captureDate: string): string {
  return `daily-${sanitizePathPart(deviceId)}-${sanitizePathPart(captureDate)}`;
}
