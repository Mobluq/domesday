import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

/**
 * DMS-018: the clip's SHA-256, taken on the phone the moment the clip is handed over.
 * Small clips use the browser's native digest; large ones stream in 4 MB chunks so a
 * long clip never has to sit in memory whole.
 */
const NATIVE_LIMIT = 48 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

export async function fingerprint(file: Blob, onProgress?: (share: number) => void, signal?: AbortSignal): Promise<string> {
  if (file.size <= NATIVE_LIMIT && globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    onProgress?.(1);
    return bytesToHex(new Uint8Array(digest));
  }
  const h = sha256.create();
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    h.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
    onProgress?.(Math.min(1, (offset + CHUNK) / file.size));
    await new Promise((r) => setTimeout(r, 0));
  }
  return bytesToHex(h.digest());
}

/** SHA-256 of text, as bytes (for verification codes). */
export async function sha256Text(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return sha256(data);
}

export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
