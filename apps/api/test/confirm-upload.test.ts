import { randomUUID } from 'node:crypto';
import { retentionUntil } from '@domesday/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectLockedError } from '../src/platform/object-store';
import { BACKENDS, createTestApp, expectContract, newKey, randomClip, sha256, type TestApp } from './helpers';

const PART = 8 * 1024 * 1024;
let t: TestApp;

interface Session {
  clipId: string;
  uploadId: string;
  partSizeBytes: number;
  partCount: number;
  parts: { partNumber: number; url: string; expiresAt: string }[];
}

/** Opens an upload session, then does what the phone does with the signed URLs. */
async function uploadClip(options: { bytes: Uint8Array; uploadBytes?: Uint8Array; token?: string; walkId?: string; roomId?: string }) {
  const clipId = randomUUID();
  const opened = await t.request({
    method: 'POST',
    url: `/v1/walks/${options.walkId ?? t.ids.walkA1}/clips/${clipId}/upload-session`,
    token: options.token ?? t.tokens.siteManagerA1,
    idempotencyKey: newKey(),
    payload: {
      roomId: options.roomId ?? t.ids.roomA1,
      sizeBytes: options.bytes.byteLength,
      contentType: 'video/mp4',
      deviceId: 'device-test-1',
      startedAtDevice: '2026-11-03T08:00:00.000Z',
      endedAtDevice: '2026-11-03T08:01:15.000Z',
      location: { latitude: 6.5244, longitude: 3.3792, accuracyMetres: 12 },
    },
  });
  expect(opened.statusCode, opened.body).toBe(201);
  expectContract('createClipUploadSession', opened);
  const session = opened.json() as Session;
  const upload = options.uploadBytes ?? options.bytes;
  const parts = session.parts.map((p) => ({
    partNumber: p.partNumber,
    etag: t.store.uploadPart(session.uploadId, p.partNumber, upload.subarray((p.partNumber - 1) * PART, p.partNumber * PART)),
  }));
  return { clipId, session, parts };
}

function confirm(clipId: string, body: object, key = newKey(), token = t.tokens.siteManagerA1) {
  return t.request({ method: 'POST', url: `/v1/clips/${clipId}/confirm`, token, idempotencyKey: key, payload: body });
}

async function auditEvents(clipId: string) {
  const response = await t.request({ method: 'GET', url: `/v1/audit-events?objectType=clip&objectId=${clipId}`, token: t.tokens.auditorA });
  expect(response.statusCode).toBe(200);
  expectContract('listAuditEvents', response);
  return response.json().items as { action: string; actorUserId: string; before: unknown; after: Record<string, unknown> }[];
}

async function rows<R>(sql: string, params: unknown[]): Promise<R[]> {
  return (await t.db.query<R>(sql, params)).rows;
}

// The upload slice runs on PGlite, and on real PostgreSQL through the production adapter when TEST_DATABASE_URL is set.
describe.each(BACKENDS)('%s', (backend) => {
  beforeAll(async () => {
    t = await createTestApp({}, backend);
  });
  afterAll(async () => {
    await t?.close();
  });

  describe('DMS-018: the server checks every clip against the fingerprint taken on the phone', () => {
    it('a matching clip is verified, kept write-once for the retention period, logged and queued for processing', async () => {
      const bytes = randomClip(PART + 1_000_000);
      const { clipId, session, parts } = await uploadClip({ bytes });
      expect(session.partCount).toBe(2);
      const deviceTime = new Date(Date.now() - 60_000).toISOString();

      const response = await confirm(clipId, { sha256: sha256(bytes), deviceTime, parts });
      expect(response.statusCode, response.body).toBe(200);
      expectContract('confirmClipUpload', response);
      const clip = response.json();
      expect(clip).toMatchObject({
        id: clipId,
        status: 'verified',
        sha256: sha256(bytes),
        serverSha256: sha256(bytes),
        capturedBy: t.ids.users.siteManagerA1,
        deviceId: 'device-test-1',
        clockGapFlag: false,
        deviceTime,
        legalHold: false,
        location: { latitude: 6.5244, longitude: 3.3792, accuracyMetres: 12 },
      });
      // DMS-136: the default retention of 13 months, counted from server time.
      expect(clip.retentionUntil).toBe(retentionUntil(new Date(clip.serverTime), 13).toISOString());

      // DMS-090: the original is write-once until the end of retention.
      const original = `originals/${t.ids.tenantA}/${t.ids.walkA1}/${clipId}`;
      expect(t.store.isLocked(original)).toBe(true);
      await expect(t.store.delete(original)).rejects.toBeInstanceOf(ObjectLockedError);

      // DMS-092: the event is in the audit log, credited to the person who confirmed it.
      const events = await auditEvents(clipId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'clip.verified', actorUserId: t.ids.users.siteManagerA1, before: { status: 'uploading' } });
      expect(events[0]?.after).toMatchObject({ status: 'verified', sha256: sha256(bytes), clockGapFlag: false });

      // Stage 2 (privacy pass) is queued, keyed by clip, stage and model version (DMS-042).
      const jobs = await rows<{ stage: string; model_version: string }>('SELECT stage, model_version FROM jobs WHERE clip_id = $1', [clipId]);
      expect(jobs).toEqual([{ stage: 'privacy_pass', model_version: 'privacy_pass@fake-0.0.0' }]);
    });

    it('given a clip altered after recording, the server rejects it as not matching its fingerprint and logs the event', async () => {
      const recorded = randomClip(300_000);
      const altered = recorded.slice();
      altered[1234] = (altered[1234] ?? 0) ^ 0xff;
      const { clipId, parts } = await uploadClip({ bytes: recorded, uploadBytes: altered });
      const key = newKey();

      const response = await confirm(clipId, { sha256: sha256(recorded), deviceTime: new Date().toISOString(), parts }, key);
      expect(response.statusCode).toBe(422);
      expectContract('confirmClipUpload', response);
      expect(response.json()).toMatchObject({ code: 'fingerprint_mismatch', clipId });

      const [stored] = await rows<{ status: string; sha256: string; server_sha256: string; storage_key: string | null }>(
        'SELECT status, sha256, server_sha256, storage_key FROM clips WHERE id = $1',
        [clipId],
      );
      expect(stored).toEqual({ status: 'rejected', sha256: sha256(recorded), server_sha256: sha256(altered), storage_key: null });

      const events = await auditEvents(clipId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: 'clip.fingerprint_mismatch', before: { status: 'uploading' } });
      expect(events[0]?.after).toMatchObject({ status: 'rejected', phoneSha256: sha256(recorded), serverSha256: sha256(altered) });
      expect(response.json().auditEventId).toBeTypeOf('string');

      // Nothing reaches write-once storage or the pipeline.
      expect(t.store.has(`originals/${t.ids.tenantA}/${t.ids.walkA1}/${clipId}`)).toBe(false);
      expect(await rows('SELECT id FROM jobs WHERE clip_id = $1', [clipId])).toEqual([]);

      // A fresh attempt with a new key is refused: a rejected clip stays rejected, and nothing new is logged.
      const fresh = await confirm(clipId, { sha256: sha256(recorded), deviceTime: '2026-11-03T09:00:00.000Z', parts }, newKey());
      expect(fresh.statusCode).toBe(409);
      expect(fresh.json().code).toBe('clip_already_rejected');
      expect(await auditEvents(clipId)).toHaveLength(1);
    });

    it('DMS-094: a phone clock two days behind is kept beside server time and flagged', async () => {
      const bytes = randomClip(50_000);
      const { clipId, parts } = await uploadClip({ bytes });
      const deviceTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const response = await confirm(clipId, { sha256: sha256(bytes), deviceTime, parts });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ clockGapFlag: true, deviceTime });
      expect(response.json().serverTime).not.toBe(deviceTime);
    });
  });

  describe('every write is safe to retry', () => {
    it('a repeat with the same Idempotency-Key returns the first response without doing the work again', async () => {
      const bytes = randomClip(40_000);
      const { clipId, parts } = await uploadClip({ bytes });
      const body = { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts };
      const key = newKey();

      const first = await confirm(clipId, body, key);
      const second = await confirm(clipId, body, key);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
      expect(await auditEvents(clipId)).toHaveLength(1);
      expect(await rows('SELECT id FROM jobs WHERE clip_id = $1', [clipId])).toHaveLength(1);
    });

    it('the same key with a different body is refused', async () => {
      const bytes = randomClip(40_000);
      const { clipId, parts } = await uploadClip({ bytes });
      const key = newKey();
      await confirm(clipId, { sha256: sha256(bytes), deviceTime: '2026-11-03T09:00:00.000Z', parts }, key);
      const reused = await confirm(clipId, { sha256: sha256(bytes), deviceTime: '2026-11-03T09:05:00.000Z', parts }, key);
      expect(reused.statusCode).toBe(422);
      expect(reused.json().code).toBe('idempotency_key_reused');
    });

    it('a rejected retry with the same key replays the rejection and logs nothing new', async () => {
      const recorded = randomClip(20_000);
      const altered = recorded.slice();
      altered[0] = (altered[0] ?? 0) ^ 1;
      const { clipId, parts } = await uploadClip({ bytes: recorded, uploadBytes: altered });
      const body = { sha256: sha256(recorded), deviceTime: '2026-11-03T09:00:00.000Z', parts };
      const key = newKey();
      const first = await confirm(clipId, body, key);
      const again = await confirm(clipId, body, key);
      expect(first.statusCode).toBe(422);
      expect(again.statusCode).toBe(422);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual(first.json());
      expect(await auditEvents(clipId)).toHaveLength(1);
    });

    it('the clip UUID made on the phone is the idempotency key: opening the session twice gives one clip and one upload', async () => {
      const clipId = randomUUID();
      const body = {
        roomId: t.ids.roomA1,
        sizeBytes: 1000,
        contentType: 'video/mp4',
        deviceId: 'device-test-1',
        startedAtDevice: '2026-11-03T08:00:00.000Z',
        endedAtDevice: '2026-11-03T08:01:00.000Z',
        location: null,
      };
      const open = (payload: object) =>
        t.request({
          method: 'POST',
          url: `/v1/walks/${t.ids.walkA1}/clips/${clipId}/upload-session`,
          token: t.tokens.siteManagerA1,
          idempotencyKey: newKey(),
          payload,
        });
      const first = await open(body);
      const second = await open(body);
      expect(second.json().uploadId).toBe(first.json().uploadId);
      expect(await rows('SELECT id FROM clips WHERE id = $1', [clipId])).toHaveLength(1);
      const different = await open({ ...body, sizeBytes: 2000 });
      expect(different.statusCode).toBe(409);
    });

    it('confirming an already verified clip again, with a new key, returns it unchanged', async () => {
      const bytes = randomClip(30_000);
      const { clipId, parts } = await uploadClip({ bytes });
      const body = { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts };
      const first = await confirm(clipId, body);
      const later = await confirm(clipId, body);
      expect(later.statusCode).toBe(200);
      expect(later.json()).toEqual(first.json());
      expect(await auditEvents(clipId)).toHaveLength(1);
    });
  });

  describe('object-level authorisation on the confirm route', () => {
    it('another tenant cannot confirm the clip and learns nothing; the clip is unchanged', async () => {
      const bytes = randomClip(20_000);
      const { clipId, parts } = await uploadClip({ bytes });
      const response = await confirm(clipId, { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts }, newKey(), t.tokens.userB);
      expect(response.statusCode).toBe(404);
      expect(await rows<{ status: string }>('SELECT status FROM clips WHERE id = $1', [clipId])).toEqual([{ status: 'uploading' }]);
      expect(await auditEvents(clipId)).toHaveLength(0);
    });

    it('a site manager of another site in the same tenant is refused', async () => {
      const bytes = randomClip(20_000);
      const { clipId, parts } = await uploadClip({ bytes });
      const response = await confirm(clipId, { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts }, newKey(), t.tokens.siteManagerA2);
      expect(response.statusCode).toBe(403);
    });
  });

  describe('incomplete uploads', () => {
    it('a confirm that lists too few parts, or a part that differs, is refused and changes nothing', async () => {
      const bytes = randomClip(PART + 500);
      const { clipId, parts } = await uploadClip({ bytes });
      const tooFew = await confirm(clipId, { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts: parts.slice(0, 1) });
      expect(tooFew.statusCode).toBe(409);
      expect(tooFew.json()).toMatchObject({ code: 'upload_incomplete', expectedParts: 2 });

      const wrongEtag = await confirm(clipId, {
        sha256: sha256(bytes),
        deviceTime: new Date().toISOString(),
        parts: [parts[0], { partNumber: 2, etag: '"not-the-etag"' }],
      });
      expect(wrongEtag.statusCode).toBe(409);
      expect(await rows<{ status: string }>('SELECT status FROM clips WHERE id = $1', [clipId])).toEqual([{ status: 'uploading' }]);
      expect(await auditEvents(clipId)).toHaveLength(0);

      const finished = await confirm(clipId, { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts });
      expect(finished.statusCode).toBe(200);
    });
  });

  describe('DMS-092 and DMS-157: the audit log pages by cursor', () => {
    it('returns newest first, one page at a time, and refuses a tampered cursor', async () => {
      for (let i = 0; i < 3; i += 1) {
        const bytes = randomClip(10_000);
        const { clipId, parts } = await uploadClip({ bytes });
        expect((await confirm(clipId, { sha256: sha256(bytes), deviceTime: new Date().toISOString(), parts })).statusCode).toBe(200);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/v1/audit-events?action=clip.verified&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await t.request({ method: 'GET', url, token: t.tokens.auditorA });
        expect(page.statusCode).toBe(200);
        expectContract('listAuditEvents', page);
        const body = page.json() as { items: { id: string; at: string }[]; nextCursor: string | null };
        expect(body.items.length).toBeLessThanOrEqual(2);
        seen.push(...body.items.map((e) => e.id));
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(pages).toBeGreaterThanOrEqual(2);

      const tampered = await t.request({ method: 'GET', url: '/v1/audit-events?cursor=bm90LWEtY3Vyc29y', token: t.tokens.auditorA });
      expect(tampered.statusCode).toBe(400);
      expect(tampered.json().code).toBe('invalid_cursor');
    });

    it('a site-scoped user cannot read the tenant-wide audit log', async () => {
      const response = await t.request({ method: 'GET', url: '/v1/audit-events', token: t.tokens.siteManagerA1 });
      expect(response.statusCode).toBe(403);
    });
  });
});
