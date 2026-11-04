import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { HttpError } from './http.js';
import type { Redis } from './redis.js';

/**
 * Stored images (frames, label shots, camera stills) for api/assets and api/blob.
 *
 * Redis keys:
 *   b:<id>  hash with the image as base64 (data), its content type (type), size and time
 *   bi      hash from id to {contentType, sizeBytes, createdAt}, so listing never reads the images
 */

export const MAX_ASSET_BYTES = 2.5 * 1024 * 1024;
export const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

export const blobKey = (id: string): string => `b:${id}`;
export const ASSET_INDEX_KEY = 'bi';

export interface AssetMeta {
  readonly id: string;
  readonly url: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export function blobUrl(id: string): string {
  return `/api/blob?id=${id}`;
}

export function isAssetId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
}

export function newAssetId(): string {
  return randomBytes(16).toString('hex');
}

/** The image type a file's first bytes show, so a stored "image" is really one. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  const ascii = (from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** The declared content type without parameters, if it is one we store. */
export function imageType(header: string | null): string | null {
  const t = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return IMAGE_TYPES.includes(t) ? t : null;
}

export async function putAsset(redis: Redis, bytes: Uint8Array, contentType: string): Promise<AssetMeta> {
  if (bytes.byteLength === 0) throw new HttpError(400, 'invalid_argument', 'The image is empty.');
  if (sniffImageType(bytes) !== contentType) throw new HttpError(400, 'invalid_argument', `The file is not a ${contentType} image.`);
  const id = newAssetId();
  const createdAt = new Date().toISOString();
  const meta = { contentType, sizeBytes: bytes.byteLength, createdAt };
  await redis.pipeline([
    ['HSET', blobKey(id), 'type', contentType, 'data', Buffer.from(bytes).toString('base64'), 'size', bytes.byteLength, 'createdAt', createdAt],
    ['HSET', ASSET_INDEX_KEY, id, JSON.stringify(meta)],
  ]);
  return { id, url: blobUrl(id), ...meta };
}

export async function listAssets(redis: Redis): Promise<AssetMeta[]> {
  const [raw] = await redis.pipeline([['HGETALL', ASSET_INDEX_KEY]]);
  const flat = Array.isArray(raw) ? raw : [];
  const out: AssetMeta[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const id = flat[i];
    if (!isAssetId(id)) continue;
    try {
      const m = JSON.parse(String(flat[i + 1])) as Partial<AssetMeta>;
      out.push({ id, url: blobUrl(id), contentType: String(m.contentType ?? 'application/octet-stream'), sizeBytes: Number(m.sizeBytes ?? 0), createdAt: String(m.createdAt ?? '') });
    } catch {
      // A broken index entry: leave it out of the list.
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export async function getAsset(redis: Redis, id: string): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const [raw] = await redis.pipeline([['HMGET', blobKey(id), 'type', 'data']]);
  const [type, data] = Array.isArray(raw) ? raw : [];
  if (typeof type !== 'string' || typeof data !== 'string') return null;
  return { contentType: type, bytes: new Uint8Array(Buffer.from(data, 'base64')) };
}

export async function deleteAsset(redis: Redis, id: string): Promise<boolean> {
  const [removed] = await redis.pipeline([
    ['DEL', blobKey(id)],
    ['HDEL', ASSET_INDEX_KEY, id],
  ]);
  return Number(removed) > 0;
}
