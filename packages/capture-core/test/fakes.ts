import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  TransientUploadError,
  type ChunkRequest,
  type CompleteRequest,
  type CompleteResult,
  type LocalClipStore,
  type UploadTransport,
} from '../src';

export const uuid = (): string => randomUUID();

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function randomClipBytes(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

/** Clip files on the "phone". */
export class FakeStore implements LocalClipStore {
  readonly files = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];

  put(clipId: string, bytes: Uint8Array): void {
    this.files.set(clipId, bytes);
  }

  async readChunk(clipId: string, offset: number, length: number): Promise<Uint8Array> {
    const file = this.files.get(clipId);
    if (!file) throw new Error(`no local file for ${clipId}`);
    return file.slice(offset, offset + length);
  }

  async delete(clipId: string): Promise<void> {
    this.deleted.push(clipId);
    this.files.delete(clipId);
  }
}

/** A stand-in for the API plus object storage: keeps parts, and recomputes the fingerprint on completion. */
export class FakeServer implements UploadTransport {
  readonly sessions = new Map<string, string>();
  readonly parts = new Map<string, Map<number, Uint8Array>>();
  readonly putLog: { clipId: string; partNumber: number; carriedFingerprint: boolean }[] = [];
  readonly completeLog: CompleteRequest[] = [];
  openSessionCalls = 0;
  /** When set, the put with this 1-based sequence number fails as if the signal dropped. */
  failOnPutNumber: number | null = null;
  private putCount = 0;

  async openSession(clip: { clipId: string }): Promise<{ uploadId: string }> {
    this.openSessionCalls += 1;
    const existing = this.sessions.get(clip.clipId);
    if (existing) return { uploadId: existing };
    const uploadId = `upload-${clip.clipId}`;
    this.sessions.set(clip.clipId, uploadId);
    this.parts.set(uploadId, new Map());
    return { uploadId };
  }

  async putChunk(request: ChunkRequest): Promise<{ etag: string }> {
    this.putCount += 1;
    if (this.failOnPutNumber !== null && this.putCount === this.failOnPutNumber) {
      throw new TransientUploadError('network connection lost');
    }
    this.parts.get(request.uploadId)?.set(request.partNumber, request.bytes);
    this.putLog.push({ clipId: request.clipId, partNumber: request.partNumber, carriedFingerprint: 'sha256' in request });
    return { etag: `"${sha256Hex(request.bytes).slice(0, 16)}"` };
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    this.completeLog.push(request);
    const stored = this.parts.get(request.uploadId) ?? new Map<number, Uint8Array>();
    const hash = createHash('sha256');
    for (const { partNumber } of request.parts) {
      const part = stored.get(partNumber);
      if (!part) throw new Error(`part ${partNumber} missing`);
      hash.update(part);
    }
    return hash.digest('hex') === request.sha256 ? { status: 'verified' } : { status: 'fingerprint_mismatch' };
  }
}

/** A clock the test moves by hand. */
export class ManualClock {
  value = Date.parse('2026-11-03T09:00:00Z');
  now = (): number => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}
