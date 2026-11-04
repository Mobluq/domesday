/** Part 6 (Video pipeline mechanics): resumable uploads in chunks of about 8 MB. */
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

export interface ChunkPlan {
  /** 1-based, as in S3 multipart uploads. */
  readonly partNumber: number;
  readonly offset: number;
  readonly length: number;
}

/** Split a clip into chunks. Every chunk is full size except the last. */
export function planChunks(sizeBytes: number, chunkSizeBytes: number = DEFAULT_CHUNK_SIZE_BYTES): ChunkPlan[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new RangeError('sizeBytes must be a positive whole number');
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) throw new RangeError('chunkSizeBytes must be positive');
  const plan: ChunkPlan[] = [];
  for (let offset = 0, partNumber = 1; offset < sizeBytes; offset += chunkSizeBytes, partNumber += 1) {
    plan.push({ partNumber, offset, length: Math.min(chunkSizeBytes, sizeBytes - offset) });
  }
  return plan;
}

export type NetworkKind = 'wifi' | 'cellular' | 'none' | 'unknown';

export interface UploadPreferences {
  /** False by default: uploads wait for Wi-Fi unless the user allows mobile data (DMS-012). */
  readonly allowMobileData: boolean;
}

export const DEFAULT_UPLOAD_PREFERENCES: UploadPreferences = Object.freeze({ allowMobileData: false });

/**
 * DMS-012 and Part 5 principle 5 ("respect a metered phone"): Wi-Fi first, mobile
 * data only after an explicit opt-in. An unknown connection is treated as metered.
 */
export function mayUploadOn(network: NetworkKind, preferences: UploadPreferences): boolean {
  if (network === 'wifi') return true;
  if (network === 'cellular') return preferences.allowMobileData;
  return false;
}

/**
 * Exponential backoff with full jitter, so phones that lost signal together do not
 * all retry at the same moment (playbook practice 3).
 */
export function backoffDelayMs(
  attempt: number,
  options: { readonly baseMs?: number; readonly capMs?: number; readonly random?: () => number } = {},
): number {
  const baseMs = options.baseMs ?? 2_000;
  const capMs = options.capMs ?? 5 * 60_000;
  const random = options.random ?? Math.random;
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
