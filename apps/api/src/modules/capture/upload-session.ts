import { ApiError } from '../../platform/errors';
import type { ObjectStore } from '../../platform/object-store';
import { ok, type OperationContext, type OperationHandler } from '../../platform/operation';
import { loadClip } from './clips';

interface CreateUploadSessionBody {
  roomId: string;
  sizeBytes: number;
  contentType: string;
  deviceId: string;
  startedAtDevice: string;
  endedAtDevice: string;
  location?: { latitude: number; longitude: number; accuracyMetres: number } | null;
}

export interface UploadSessionDeps {
  readonly objectStore: ObjectStore;
  /** About 8 MB (Part 6). S3 needs at least 5 MiB for every part but the last. */
  readonly partSizeBytes: number;
  /** Signed part URLs are short-lived; the phone asks for fresh ones to resume. */
  readonly partUrlTtlSeconds: number;
}

async function signParts(deps: UploadSessionDeps, key: string, uploadId: string, partCount: number) {
  const parts = [];
  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const { url, expiresAt } = await deps.objectStore.signPartUrl(key, uploadId, partNumber, deps.partUrlTtlSeconds);
    parts.push({ partNumber, url, expiresAt: expiresAt.toISOString() });
  }
  return parts;
}

/**
 * Opens the resumable upload for a clip (DMS-012). The clip UUID made on the phone
 * is the idempotency key: asking again for the same clip returns the same session,
 * so a retried upload can never create a second clip (Part 6 data model).
 * Capture metadata is fixed here, with the filmer taken from the signed-in user,
 * never from the request (DMS-017, DMS-022).
 */
export function createUploadSessionHandler(deps: UploadSessionDeps): OperationHandler {
  return async (ctx: OperationContext) => {
    const walkId = ctx.params.walkId as string;
    const clipId = ctx.params.clipId as string;
    const body = ctx.body as CreateUploadSessionBody;

    const walk = (await ctx.tx.query<{ site_id: string; status: string }>('SELECT site_id, status FROM walks WHERE id = $1', [walkId])).rows[0];
    if (!walk) throw new ApiError(404, 'not_found', `There is no walk ${walkId} that you can see.`);
    if (walk.status === 'approved') throw new ApiError(409, 'conflict', 'This walk is approved, so no more clips can be added.');
    if (ctx.objects.get('roomId')?.siteId !== walk.site_id) {
      throw new ApiError(409, 'conflict', "The room is not on this walk's site.");
    }
    if (Date.parse(body.endedAtDevice) < Date.parse(body.startedAtDevice)) {
      throw new ApiError(400, 'validation_failed', 'endedAtDevice is before startedAtDevice.');
    }
    const partCount = Math.ceil(body.sizeBytes / deps.partSizeBytes);
    if (partCount > 10_000) throw new ApiError(400, 'validation_failed', 'The clip is too large for one upload.');

    const existing = await loadClip(ctx.tx, clipId);
    if (existing) {
      const same =
        existing.walk_id === walkId &&
        existing.room_id === body.roomId &&
        existing.captured_by === ctx.principal.userId &&
        Number(existing.size_bytes) === body.sizeBytes;
      if (!same) throw new ApiError(409, 'conflict', 'This clip ID is already in use for a different clip.');
      if (existing.status === 'verified') throw new ApiError(409, 'clip_already_verified', 'This clip has already been uploaded and verified.');
      if (existing.status === 'rejected') throw new ApiError(409, 'clip_already_rejected', 'This clip was rejected: it did not match its fingerprint.');
      if (!existing.upload_id || !existing.part_size_bytes || !existing.part_count) throw new Error(`clip ${clipId} has no upload session`);
      return ok(
        {
          clipId,
          uploadId: existing.upload_id,
          partSizeBytes: existing.part_size_bytes,
          partCount: existing.part_count,
          parts: await signParts(deps, existing.staging_key, existing.upload_id, existing.part_count),
        },
        201,
      );
    }

    const stagingKey = `staging/${ctx.principal.tenantId}/${walkId}/${clipId}`;
    const location = body.location ?? null;
    try {
      await ctx.tx.query(
        `INSERT INTO clips (id, tenant_id, walk_id, room_id, site_id, captured_by, device_id, started_at_device, ended_at_device,
                            location_latitude, location_longitude, location_accuracy_m, status, size_bytes, content_type, staging_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'uploading', $13, $14, $15)`,
        [
          clipId,
          ctx.principal.tenantId,
          walkId,
          body.roomId,
          walk.site_id,
          ctx.principal.userId,
          body.deviceId,
          body.startedAtDevice,
          body.endedAtDevice,
          location?.latitude ?? null,
          location?.longitude ?? null,
          location?.accuracyMetres ?? null,
          body.sizeBytes,
          body.contentType,
          stagingKey,
        ],
      );
    } catch (error) {
      // The ID exists, but not in this tenant (row-level security hid it above).
      if ((error as { code?: string }).code === '23505') throw new ApiError(409, 'conflict', 'This clip ID is already in use.');
      throw error;
    }
    const { uploadId } = await deps.objectStore.createMultipartUpload(stagingKey, body.contentType);
    await ctx.tx.query(
      'INSERT INTO upload_sessions (tenant_id, clip_id, upload_id, part_size_bytes, part_count) VALUES ($1, $2, $3, $4, $5)',
      [ctx.principal.tenantId, clipId, uploadId, deps.partSizeBytes, partCount],
    );
    return ok(
      { clipId, uploadId, partSizeBytes: deps.partSizeBytes, partCount, parts: await signParts(deps, stagingKey, uploadId, partCount) },
      201,
    );
  };
}
