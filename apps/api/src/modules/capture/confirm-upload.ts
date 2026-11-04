import { createHash } from 'node:crypto';
import { assessClockGap, retentionUntil } from '@domesday/domain';
import { ApiError } from '../../platform/errors';
import { UploadIncompleteError, type ObjectStore } from '../../platform/object-store';
import { ok, refusal, type OperationContext, type OperationHandler } from '../../platform/operation';
import type { EvidenceApi } from '../evidence/index';
import type { ProcessingApi } from '../processing/index';
import type { TenancyApi } from '../tenancy-access/index';
import { CLIP_COLUMNS, loadClip, toClip, type ClipRow } from './clips';

interface ConfirmBody {
  sha256: string;
  deviceTime: string;
  parts: { partNumber: number; etag: string }[];
}

export interface ConfirmUploadDeps {
  readonly objectStore: ObjectStore;
  readonly evidence: EvidenceApi;
  readonly tenancy: TenancyApi;
  readonly processing: ProcessingApi;
}

async function sha256Of(store: ObjectStore, key: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of store.read(key)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Stage 1 of the pipeline, "ingest and verify" (Part 5), for one clip.
 *
 * DMS-018: the phone sends the fingerprint it computed when recording stopped; the
 * server completes the upload, recomputes the SHA-256 and compares. A mismatch
 * rejects the clip and logs the event (DMS-092). A match copies the original to
 * write-once storage for the tenant's retention period (DMS-090, DMS-136) and queues
 * processing. DMS-094: server time is the record of truth, with the phone's clock
 * kept beside it and a gap of more than 10 minutes flagged.
 */
export function createConfirmUploadHandler(deps: ConfirmUploadDeps): OperationHandler {
  return async (ctx: OperationContext) => {
    const clipId = ctx.params.clipId as string;
    const body = ctx.body as ConfirmBody;
    const tenantId = ctx.principal.tenantId;

    const clip = await loadClip(ctx.tx, clipId, true);
    if (!clip) throw new ApiError(404, 'not_found', `There is no clip ${clipId} that you can see.`);

    // A repeat after success returns the same clip; the clip UUID is the idempotency key.
    if (clip.status === 'verified') {
      if (clip.sha256 === body.sha256) return ok(toClip(clip));
      throw new ApiError(409, 'clip_already_verified', 'This clip was already verified with a different fingerprint.');
    }
    if (clip.status === 'rejected') {
      throw new ApiError(409, 'clip_already_rejected', 'This clip was rejected because it did not match its fingerprint.');
    }
    if (!clip.upload_id) throw new ApiError(409, 'upload_incomplete', 'This clip has no upload session.');
    const listed = new Set(body.parts.map((p) => p.partNumber));
    if (listed.size !== body.parts.length || listed.size !== clip.part_count) {
      throw new ApiError(409, 'upload_incomplete', `This clip has ${clip.part_count} parts; list each uploaded part once.`, {
        expectedParts: clip.part_count,
      });
    }

    try {
      await deps.objectStore.completeMultipartUpload(clip.staging_key, clip.upload_id, body.parts);
    } catch (error) {
      if (error instanceof UploadIncompleteError) {
        throw new ApiError(409, 'upload_incomplete', 'Some parts are missing or differ from what was uploaded. Upload them, then confirm again.');
      }
      throw error;
    }

    const serverSha256 = await sha256Of(deps.objectStore, clip.staging_key);
    const serverTime = ctx.now;
    const deviceTime = new Date(body.deviceTime);
    const clockGap = assessClockGap(deviceTime, serverTime);
    const actor = { actorKind: 'user' as const, actorUserId: ctx.principal.userId, requestId: ctx.requestId };

    if (serverSha256 !== body.sha256) {
      await ctx.tx.query(
        `UPDATE clips SET status = 'rejected', sha256 = $2, server_sha256 = $3, device_time = $4, server_time = $5, rejected_at = $5
         WHERE id = $1`,
        [clipId, body.sha256, serverSha256, deviceTime.toISOString(), serverTime.toISOString()],
      );
      const event = await deps.evidence.appendAuditEvent(ctx.tx, tenantId, {
        ...actor,
        action: 'clip.fingerprint_mismatch',
        objectType: 'clip',
        objectId: clipId,
        before: { status: clip.status },
        after: { status: 'rejected', phoneSha256: body.sha256, serverSha256, clockGapFlag: clockGap.flagged },
        reason: 'The uploaded clip does not match the fingerprint computed on the phone when recording stopped.',
      });
      // A refusal that commits: the rejection and its audit event must be kept.
      return refusal(
        422,
        'fingerprint_mismatch',
        'The clip does not match the fingerprint recorded on the phone. It has been rejected and the event logged.',
        ctx.requestId,
        { clipId, auditEventId: event.id },
      );
    }

    const settings = await deps.tenancy.getTenantSettings(ctx.tx, tenantId);
    const retainUntil = retentionUntil(serverTime, settings.originalsRetentionMonths);
    const storageKey = `originals/${tenantId}/${clip.walk_id}/${clipId}`;
    await deps.objectStore.copyToWriteOnce(clip.staging_key, storageKey, retainUntil);

    const { rows } = await ctx.tx.query<ClipRow>(
      `WITH updated AS (
         UPDATE clips SET status = 'verified', sha256 = $2, server_sha256 = $2, device_time = $3, server_time = $4,
                          storage_key = $5, retention_until = $6, verified_at = $4
         WHERE id = $1 RETURNING *
       )
       SELECT ${CLIP_COLUMNS}
       FROM updated c LEFT JOIN upload_sessions s ON s.tenant_id = c.tenant_id AND s.clip_id = c.id`,
      [clipId, serverSha256, deviceTime.toISOString(), serverTime.toISOString(), storageKey, retainUntil.toISOString()],
    );
    const verified = rows[0];
    if (!verified) throw new Error(`clip ${clipId} disappeared during confirmation`);
    await ctx.tx.query('UPDATE upload_sessions SET completed_at = $2 WHERE clip_id = $1', [clipId, serverTime.toISOString()]);

    await deps.evidence.appendAuditEvent(ctx.tx, tenantId, {
      ...actor,
      action: 'clip.verified',
      objectType: 'clip',
      objectId: clipId,
      before: { status: clip.status },
      after: {
        status: 'verified',
        sha256: serverSha256,
        clockGapFlag: clockGap.flagged,
        clockGapMs: clockGap.gapMs,
        retentionUntil: retainUntil.toISOString(),
      },
    });
    await deps.processing.enqueueAfterVerification(ctx.tx, { tenantId, walkId: clip.walk_id, clipId });
    return ok(toClip(verified));
  };
}
