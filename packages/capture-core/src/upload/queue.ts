import type { CaptureMetadata, ClosedClip } from '../clip';
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_UPLOAD_PREFERENCES,
  backoffDelayMs,
  mayUploadOn,
  planChunks,
  type NetworkKind,
  type UploadPreferences,
} from './policy';

export type QueueItemState =
  | 'queued'
  | 'uploading'
  | 'waiting_for_network'
  | 'retry_scheduled'
  | 'verified'
  | 'rejected'
  | 'needs_attention';

/** One clip waiting to upload. Plain data, so the queue can be saved and restored across app restarts. */
export interface QueueItem {
  readonly clipId: string;
  readonly metadata: CaptureMetadata;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly chunkSizeBytes: number;
  readonly uploadId: string | null;
  /** Chunks the server has confirmed: part number to the receipt (ETag) it returned. */
  readonly confirmedParts: Readonly<Record<string, string>>;
  readonly state: QueueItemState;
  readonly attempts: number;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
}

export interface ChunkRequest {
  readonly clipId: string;
  readonly uploadId: string;
  readonly partNumber: number;
  readonly offset: number;
  readonly length: number;
  readonly bytes: Uint8Array;
  readonly idempotencyKey: string;
}

/** The final request of an upload. It carries the fingerprint computed when recording stopped (DMS-018). */
export interface CompleteRequest {
  readonly clipId: string;
  readonly uploadId: string;
  readonly sha256: string;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
  /** The phone's clock as it sends this request, so the server can flag a clock gap (DMS-094). */
  readonly deviceTime: string;
  readonly idempotencyKey: string;
}

export type CompleteResult = { readonly status: 'verified' } | { readonly status: 'fingerprint_mismatch' };

/** How the queue talks to the API and to object storage. The phone app supplies the real one. */
export interface UploadTransport {
  /** Create the clip's upload session, or return the existing one: the clip UUID is the idempotency key. */
  openSession(clip: {
    readonly clipId: string;
    readonly metadata: CaptureMetadata;
    readonly sizeBytes: number;
    readonly chunkSizeBytes: number;
  }): Promise<{ readonly uploadId: string }>;
  putChunk(request: ChunkRequest): Promise<{ readonly etag: string }>;
  complete(request: CompleteRequest): Promise<CompleteResult>;
}

/** A failure worth retrying later from the last confirmed chunk: lost signal, a timeout, a 5xx. */
export class TransientUploadError extends Error {
  override readonly name = 'TransientUploadError';
}

/** A failure that retrying will not fix, such as a refused permission. The clip stays on the phone. */
export class PermanentUploadError extends Error {
  override readonly name = 'PermanentUploadError';
}

/** Encrypted clip files on the phone (DMS-023). */
export interface LocalClipStore {
  readChunk(clipId: string, offset: number, length: number): Promise<Uint8Array>;
  /** DMS-023: called only after the server has confirmed the clip. */
  delete(clipId: string): Promise<void>;
}

export interface UploadQueueDeps {
  readonly transport: UploadTransport;
  readonly store: LocalClipStore;
  readonly network: () => NetworkKind;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly chunkSizeBytes?: number;
  /** Called after every change so the app can save the queue (for example after each confirmed chunk). */
  readonly onChange?: (snapshot: UploadQueueSnapshot) => void;
}

export interface UploadQueueSnapshot {
  readonly version: 1;
  readonly preferences: UploadPreferences;
  readonly items: readonly QueueItem[];
}

export interface RunReport {
  readonly chunksSent: number;
  readonly verified: readonly string[];
  readonly rejected: readonly string[];
  readonly retryScheduled: readonly string[];
  readonly needsAttention: readonly string[];
  readonly waitingForNetwork: boolean;
}

const FINISHED: readonly QueueItemState[] = ['verified', 'rejected', 'needs_attention'];

/**
 * DMS-011, DMS-012, DMS-018, DMS-023: the offline upload queue.
 *
 * Clips are queued when recording stops and upload later, chunk by chunk. An
 * interrupted upload resumes from the last confirmed chunk, never from zero.
 * Uploads wait for Wi-Fi unless the user allows mobile data. The fingerprint goes
 * with the final request, and the local copy is deleted only once the server has
 * confirmed the clip.
 */
export class UploadQueue {
  private readonly items = new Map<string, QueueItem>();
  private readonly deps: UploadQueueDeps;
  private preferences: UploadPreferences;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(deps: UploadQueueDeps, snapshot?: UploadQueueSnapshot) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.preferences = snapshot?.preferences ?? DEFAULT_UPLOAD_PREFERENCES;
    for (const item of snapshot?.items ?? []) {
      // An upload cut off mid-flight by an app restart resumes from its confirmed chunks.
      this.items.set(item.clipId, item.state === 'uploading' ? { ...item, state: 'queued' } : item);
    }
  }

  /** Queue a closed clip. Queuing the same clip again changes nothing: its UUID is the key. */
  enqueue(clip: ClosedClip): QueueItem {
    const existing = this.items.get(clip.metadata.clipId);
    if (existing) return existing;
    const item: QueueItem = {
      clipId: clip.metadata.clipId,
      metadata: clip.metadata,
      sha256: clip.sha256,
      sizeBytes: clip.sizeBytes,
      chunkSizeBytes: this.deps.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
      uploadId: null,
      confirmedParts: {},
      state: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    };
    this.save(item);
    return item;
  }

  setPreferences(preferences: UploadPreferences): void {
    this.preferences = { ...preferences };
    this.deps.onChange?.(this.snapshot());
  }

  get(clipId: string): QueueItem | undefined {
    return this.items.get(clipId);
  }

  list(): QueueItem[] {
    return [...this.items.values()];
  }

  /** A deep copy as plain JSON data. (Not structuredClone: React Native's Hermes engine lacks it.) */
  snapshot(): UploadQueueSnapshot {
    return JSON.parse(JSON.stringify({ version: 1, preferences: this.preferences, items: this.list() })) as UploadQueueSnapshot;
  }

  /** Try every clip that is due once, one at a time. Safe to call whenever the network or app state changes. */
  async runOnce(): Promise<RunReport> {
    const report = {
      chunksSent: 0,
      verified: [] as string[],
      rejected: [] as string[],
      retryScheduled: [] as string[],
      needsAttention: [] as string[],
      waitingForNetwork: false,
    };
    for (const item of this.list()) {
      if (FINISHED.includes(item.state)) continue;
      if (item.nextAttemptAt !== null && item.nextAttemptAt > this.now()) continue;
      if (!this.mayUpload()) {
        this.save({ ...item, state: 'waiting_for_network' });
        report.waitingForNetwork = true;
        continue;
      }
      const outcome = await this.upload(item, report);
      if (outcome === 'waiting_for_network') report.waitingForNetwork = true;
    }
    return report;
  }

  private mayUpload(): boolean {
    return mayUploadOn(this.deps.network(), this.preferences);
  }

  private save(item: QueueItem): QueueItem {
    this.items.set(item.clipId, item);
    this.deps.onChange?.(this.snapshot());
    return item;
  }

  private async upload(
    start: QueueItem,
    report: {
      chunksSent: number;
      verified: string[];
      rejected: string[];
      retryScheduled: string[];
      needsAttention: string[];
    },
  ): Promise<'done' | 'waiting_for_network' | 'retry'> {
    let item = this.save({ ...start, state: 'uploading', nextAttemptAt: null });
    try {
      if (item.uploadId === null) {
        const session = await this.deps.transport.openSession({
          clipId: item.clipId,
          metadata: item.metadata,
          sizeBytes: item.sizeBytes,
          chunkSizeBytes: item.chunkSizeBytes,
        });
        item = this.save({ ...item, uploadId: session.uploadId });
      }
      const uploadId = item.uploadId as string;

      for (const chunk of planChunks(item.sizeBytes, item.chunkSizeBytes)) {
        if (item.confirmedParts[String(chunk.partNumber)] !== undefined) continue; // resume after the last confirmed chunk
        if (!this.mayUpload()) {
          this.save({ ...item, state: 'waiting_for_network' });
          return 'waiting_for_network';
        }
        const bytes = await this.deps.store.readChunk(item.clipId, chunk.offset, chunk.length);
        const { etag } = await this.deps.transport.putChunk({
          clipId: item.clipId,
          uploadId,
          partNumber: chunk.partNumber,
          offset: chunk.offset,
          length: chunk.length,
          bytes,
          idempotencyKey: `${item.clipId}:part:${chunk.partNumber}`,
        });
        item = this.save({ ...item, confirmedParts: { ...item.confirmedParts, [String(chunk.partNumber)]: etag } });
        report.chunksSent += 1;
      }

      const parts = Object.entries(item.confirmedParts)
        .map(([partNumber, etag]) => ({ partNumber: Number(partNumber), etag }))
        .sort((a, b) => a.partNumber - b.partNumber);
      const result = await this.deps.transport.complete({
        clipId: item.clipId,
        uploadId,
        sha256: item.sha256,
        parts,
        deviceTime: new Date(this.now()).toISOString(),
        idempotencyKey: `${item.clipId}:complete`,
      });

      if (result.status === 'verified') {
        this.save({ ...item, state: 'verified', lastError: null });
        await this.deps.store.delete(item.clipId); // DMS-023: only after the server confirms
        report.verified.push(item.clipId);
      } else {
        // The server refused the clip and logged it (DMS-018). Keep the local copy for investigation; never retry.
        this.save({ ...item, state: 'rejected', lastError: 'fingerprint_mismatch' });
        report.rejected.push(item.clipId);
      }
      return 'done';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentUploadError) {
        this.save({ ...item, state: 'needs_attention', lastError: message });
        report.needsAttention.push(item.clipId);
        return 'done';
      }
      const attempts = item.attempts + 1;
      this.save({
        ...item,
        state: 'retry_scheduled',
        attempts,
        nextAttemptAt: this.now() + backoffDelayMs(attempts, { random: this.random }),
        lastError: message,
      });
      report.retryScheduled.push(item.clipId);
      return 'retry';
    }
  }
}
