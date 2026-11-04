import { createHash, randomUUID } from 'node:crypto';

/**
 * Object storage (Part 6, video pipeline mechanics). Phones upload parts straight
 * to storage through short-lived signed URLs; the API never handles the video.
 * Verified originals are copied to a write-once area locked for the retention
 * period (object lock in compliance mode in production, DMS-090).
 *
 * The production implementation (S3-compatible, with object lock) is not built
 * yet; the in-memory store below backs development and tests.
 */
export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface ObjectStore {
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  signPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<{ url: string; expiresAt: Date }>;
  completeMultipartUpload(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void>;
  read(key: string): AsyncIterable<Uint8Array>;
  /** Copy into write-once storage. Nobody can delete or overwrite the copy before retainUntil. */
  copyToWriteOnce(fromKey: string, toKey: string, retainUntil: Date): Promise<void>;
  delete(key: string): Promise<void>;
}

export class UploadIncompleteError extends Error {
  override readonly name = 'UploadIncompleteError';
}

export class ObjectLockedError extends Error {
  override readonly name = 'ObjectLockedError';
}

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
}

interface PendingUpload {
  readonly key: string;
  readonly parts: Map<number, { bytes: Uint8Array; etag: string }>;
}

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly locks = new Map<string, Date>();
  private readonly uploads = new Map<string, PendingUpload>();
  private readonly now: () => Date;
  private readonly baseUrl: string;

  constructor(options: { now?: () => Date; baseUrl?: string } = {}) {
    this.now = options.now ?? (() => new Date());
    this.baseUrl = options.baseUrl ?? 'https://storage.invalid';
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return { uploadId };
  }

  async signPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds: number) {
    const expiresAt = new Date(this.now().getTime() + expiresInSeconds * 1000);
    const url = `${this.baseUrl}/${encodeURIComponent(key)}?uploadId=${uploadId}&partNumber=${partNumber}&expires=${expiresAt.getTime()}`;
    return { url, expiresAt };
  }

  /** What a phone's PUT to a signed part URL does. Returns the part's ETag. */
  uploadPart(uploadId: string, partNumber: number, bytes: Uint8Array): string {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new ObjectNotFoundError(`no upload ${uploadId}`);
    const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
    upload.parts.set(partNumber, { bytes, etag });
    return etag;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: readonly UploadedPart[]): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new UploadIncompleteError(`no upload ${uploadId} for ${key}`);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Uint8Array[] = [];
    for (const part of ordered) {
      const stored = upload.parts.get(part.partNumber);
      if (!stored || stored.etag !== part.etag) throw new UploadIncompleteError(`part ${part.partNumber} is missing or different`);
      chunks.push(stored.bytes);
    }
    if (ordered.length !== upload.parts.size) throw new UploadIncompleteError('some uploaded parts were not listed');
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.byteLength;
    }
    await this.assertWritable(key);
    this.objects.set(key, joined);
    this.uploads.delete(uploadId);
  }

  async *read(key: string): AsyncIterable<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new ObjectNotFoundError(`no object ${key}`);
    const step = 1024 * 1024;
    for (let i = 0; i < object.byteLength; i += step) yield object.subarray(i, i + step);
  }

  async copyToWriteOnce(fromKey: string, toKey: string, retainUntil: Date): Promise<void> {
    const object = this.objects.get(fromKey);
    if (!object) throw new ObjectNotFoundError(`no object ${fromKey}`);
    await this.assertWritable(toKey);
    this.objects.set(toKey, object.slice());
    this.locks.set(toKey, retainUntil);
  }

  async delete(key: string): Promise<void> {
    await this.assertWritable(key);
    this.objects.delete(key);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  isLocked(key: string): boolean {
    const until = this.locks.get(key);
    return until !== undefined && until.getTime() > this.now().getTime();
  }

  private async assertWritable(key: string): Promise<void> {
    if (this.isLocked(key)) throw new ObjectLockedError(`${key} is write-once until ${this.locks.get(key)?.toISOString()}`);
  }
}
