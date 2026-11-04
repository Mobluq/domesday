import type { Queryable } from '../../platform/db';

/** A clip row as the capture module reads it. Only this module touches the clips table. */
export interface ClipRow {
  id: string;
  walk_id: string;
  room_id: string;
  site_id: string;
  status: 'pending' | 'uploading' | 'verified' | 'rejected';
  captured_by: string;
  device_id: string;
  started_at_device: Date | string;
  ended_at_device: Date | string;
  location_latitude: number | null;
  location_longitude: number | null;
  location_accuracy_m: number | null;
  size_bytes: string;
  content_type: string;
  staging_key: string;
  storage_key: string | null;
  sha256: string | null;
  server_sha256: string | null;
  device_time: Date | string | null;
  server_time: Date | string | null;
  clock_gap_flag: boolean | null;
  retention_until: Date | string | null;
  legal_hold: boolean;
  upload_id: string | null;
  part_size_bytes: number | null;
  part_count: number | null;
}

export const CLIP_COLUMNS = `
  c.id, c.walk_id, c.room_id, c.site_id, c.status, c.captured_by, c.device_id, c.started_at_device, c.ended_at_device,
  c.location_latitude, c.location_longitude, c.location_accuracy_m, c.size_bytes::text AS size_bytes, c.content_type,
  c.staging_key, c.storage_key, c.sha256, c.server_sha256, c.device_time, c.server_time, c.clock_gap_flag,
  c.retention_until, c.legal_hold, s.upload_id, s.part_size_bytes, s.part_count`;

export async function loadClip(tx: Queryable, clipId: string, forUpdate = false): Promise<ClipRow | null> {
  const { rows } = await tx.query<ClipRow>(
    `SELECT ${CLIP_COLUMNS}
     FROM clips c LEFT JOIN upload_sessions s ON s.tenant_id = c.tenant_id AND s.clip_id = c.id
     WHERE c.id = $1 ${forUpdate ? 'FOR UPDATE OF c' : ''}`,
    [clipId],
  );
  return rows[0] ?? null;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/** The Clip schema in openapi/domesday.yaml. */
export function toClip(row: ClipRow) {
  return {
    id: row.id,
    walkId: row.walk_id,
    roomId: row.room_id,
    status: row.status,
    capturedBy: row.captured_by,
    deviceId: row.device_id,
    startedAtDevice: iso(row.started_at_device),
    endedAtDevice: iso(row.ended_at_device),
    location:
      row.location_latitude === null || row.location_longitude === null
        ? null
        : { latitude: row.location_latitude, longitude: row.location_longitude, accuracyMetres: row.location_accuracy_m ?? 0 },
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    serverSha256: row.server_sha256,
    deviceTime: iso(row.device_time),
    serverTime: iso(row.server_time),
    clockGapFlag: row.clock_gap_flag,
    retentionUntil: iso(row.retention_until),
    legalHold: row.legal_hold,
  };
}
