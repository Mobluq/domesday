import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Hashes a clip a chunk at a time, so a 90 MB clip never has to sit in memory at once. */
export interface IncrementalHasher {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

export type HasherFactory = () => IncrementalHasher;

/**
 * SHA-256 in pure JavaScript (@noble/hashes, audited), so the same code runs on
 * Android, iOS and in Node tests. A native implementation can be passed in
 * wherever a HasherFactory is accepted if profiling on reference devices calls for it.
 */
export const createSha256Hasher: HasherFactory = () => {
  const hash = sha256.create();
  return {
    update: (chunk) => {
      hash.update(chunk);
    },
    digestHex: () => bytesToHex(hash.digest()),
  };
};

export interface Fingerprint {
  /** Lower-case hex SHA-256 of the whole clip. */
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** DMS-018: compute the clip's fingerprint from its bytes. */
export async function fingerprintChunks(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  createHasher: HasherFactory = createSha256Hasher,
): Promise<Fingerprint> {
  const hasher = createHasher();
  let sizeBytes = 0;
  for await (const chunk of chunks) {
    hasher.update(chunk);
    sizeBytes += chunk.byteLength;
  }
  return { sha256: hasher.digestHex(), sizeBytes };
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
