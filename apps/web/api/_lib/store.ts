import { HttpError, isRecord } from './http.js';
import type { Redis, RedisCommand } from './redis.js';

/**
 * The shared document store behind api/db, with the semantics of src/runtime/memory-db.ts:
 * paths with an even number of segments are documents, odd are collections; update()
 * needs the document to exist and merges nested objects recursively while arrays replace.
 *
 * Redis keys:
 *   d:<path>            the document, as JSON
 *   c:<collectionPath>  set of the ids of the documents directly in that collection
 *   v                   global version, incremented on every write
 */

export type Json = Record<string, unknown>;

export const MAX_SEGMENTS = 16;
export const MAX_DOC_BYTES = 256 * 1024;
/** Paths per getMany, and collections per list. */
export const MAX_DOCS_PER_READ = 500;
export const MAX_COLLECTIONS_PER_LIST = 50;

const SEGMENT = /^[A-Za-z0-9_.~:@+-]{1,256}$/;

export const docKey = (path: string): string => `d:${path}`;
export const collKey = (path: string): string => `c:${path}`;
export const VERSION_KEY = 'v';

function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid_argument', message);
}

function segments(path: unknown): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048) throw invalid('A path must be a non-empty string.');
  const parts = path.split('/');
  if (parts.length > MAX_SEGMENTS) throw invalid(`"${path.slice(0, 80)}" has more than ${MAX_SEGMENTS} segments.`);
  if (!parts.every((p) => SEGMENT.test(p))) throw invalid(`"${path.slice(0, 80)}" is not a valid path: use letters, digits and _ - . ~ : @ + between slashes.`);
  return parts;
}

export function docPath(path: unknown): string {
  const parts = segments(path);
  if (parts.length % 2 !== 0) throw invalid(`"${String(path)}" is not a document path`);
  return parts.join('/');
}

export function collectionPath(path: unknown): string {
  const parts = segments(path);
  if (parts.length % 2 !== 1) throw invalid(`"${String(path)}" is not a collection path`);
  return parts.join('/');
}

function split(path: string): { parent: string; id: string } {
  const i = path.lastIndexOf('/');
  return { parent: path.slice(0, i), id: path.slice(i + 1) };
}

export function deepMerge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] = isRecord(v) && isRecord(prev) ? deepMerge(prev, v) : v;
  }
  return out;
}

const encoder = new TextEncoder();

function encodeDoc(data: unknown, path: string): string {
  if (!isRecord(data)) throw invalid(`The data for ${path} must be an object.`);
  const text = JSON.stringify(data);
  if (encoder.encode(text).byteLength > MAX_DOC_BYTES) throw new HttpError(413, 'too_large', `${path} would be larger than ${MAX_DOC_BYTES / 1024} KB.`);
  return text;
}

function decodeDoc(raw: unknown): Json | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function toVersion(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

function pathList(raw: unknown, max: number, check: (p: unknown) => string): string[] {
  if (!Array.isArray(raw)) throw invalid('paths must be an array of strings.');
  if (raw.length > max) throw invalid(`At most ${max} paths at a time.`);
  return [...new Set(raw.map(check))];
}

export interface ListedDoc {
  readonly id: string;
  readonly data: Json;
}

export class DocStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async version(): Promise<number> {
    const [v] = await this.redis.pipeline([['GET', VERSION_KEY]]);
    return toVersion(v);
  }

  async get(path: string): Promise<Json | null> {
    const [raw] = await this.redis.pipeline([['GET', docKey(path)]]);
    return decodeDoc(raw);
  }

  /** Several documents in one round trip, with the version read just before them. */
  async getMany(paths: readonly string[]): Promise<{ version: number; docs: Record<string, Json | null> }> {
    const docs: Record<string, Json | null> = {};
    if (paths.length === 0) return { version: await this.version(), docs };
    const [v, values] = await this.redis.pipeline([['GET', VERSION_KEY], ['MGET', ...paths.map(docKey)]]);
    const list = Array.isArray(values) ? values : [];
    paths.forEach((p, i) => {
      docs[p] = decodeDoc(list[i]);
    });
    return { version: toVersion(v), docs };
  }

  /** Every document of each collection, sorted by id. Two round trips however many collections. */
  async list(paths: readonly string[]): Promise<{ version: number; collections: Record<string, ListedDoc[]> }> {
    const collections: Record<string, ListedDoc[]> = {};
    const [v, ...members] = await this.redis.pipeline([['GET', VERSION_KEY], ...paths.map((p): RedisCommand => ['SMEMBERS', collKey(p)])]);
    const wanted: { coll: string; id: string }[] = [];
    paths.forEach((p, i) => {
      const ids = Array.isArray(members[i]) ? (members[i] as unknown[]).filter((m): m is string => typeof m === 'string') : [];
      ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const id of ids) wanted.push({ coll: p, id });
      collections[p] = [];
    });
    if (wanted.length > 0) {
      const [values] = await this.redis.pipeline([['MGET', ...wanted.map((w) => docKey(`${w.coll}/${w.id}`))]]);
      const list = Array.isArray(values) ? values : [];
      wanted.forEach((w, i) => {
        // A member whose document is gone (an interrupted write) is skipped.
        const data = decodeDoc(list[i]);
        if (data) collections[w.coll]?.push({ id: w.id, data });
      });
    }
    return { version: toVersion(v), collections };
  }

  async set(path: string, data: unknown): Promise<number> {
    return this.write(path, encodeDoc(data, path));
  }

  async update(path: string, patch: unknown): Promise<number> {
    if (!isRecord(patch)) throw invalid(`The data for ${path} must be an object.`);
    const prev = await this.get(path);
    if (!prev) throw invalid(`${path} does not exist`);
    return this.write(path, encodeDoc(deepMerge(prev, patch), path));
  }

  async delete(path: string): Promise<number> {
    const { parent, id } = split(path);
    const results = await this.redis.pipeline([['DEL', docKey(path)], ['SREM', collKey(parent), id], ['INCR', VERSION_KEY]]);
    return toVersion(results[2]);
  }

  private async write(path: string, text: string): Promise<number> {
    const { parent, id } = split(path);
    const results = await this.redis.pipeline([['SET', docKey(path), text], ['SADD', collKey(parent), id], ['INCR', VERSION_KEY]]);
    return toVersion(results[2]);
  }
}

/** One request to api/db: { op, path?, paths?, data? }. */
export async function runDbOp(store: DocStore, body: unknown): Promise<Record<string, unknown>> {
  if (!isRecord(body)) throw invalid('Send a JSON object with an op.');
  const { op } = body;
  switch (op) {
    case 'version':
      return { version: await store.version() };
    case 'get':
      return { data: await store.get(docPath(body.path)) };
    case 'set':
      return { ok: true, version: await store.set(docPath(body.path), body.data) };
    case 'update':
      return { ok: true, version: await store.update(docPath(body.path), body.data) };
    case 'delete':
      return { ok: true, version: await store.delete(docPath(body.path)) };
    case 'getMany':
      return await store.getMany(pathList(body.paths, MAX_DOCS_PER_READ, docPath));
    case 'list': {
      if (body.paths !== undefined) return await store.list(pathList(body.paths, MAX_COLLECTIONS_PER_LIST, collectionPath));
      const path = collectionPath(body.path);
      const { version, collections } = await store.list([path]);
      return { version, docs: collections[path] ?? [] };
    }
    default:
      throw invalid('op must be one of get, set, update, delete, list, getMany or version.');
  }
}
