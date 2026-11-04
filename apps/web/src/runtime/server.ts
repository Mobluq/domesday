import type { AssetsLike, CollRef, DbError, DbLike, DocRef, DocSnap, Json, QuerySnap, SampleFn, SampleImageLimits, SampleOptions, Unsubscribe } from './types';

/**
 * The runtime on the Domesday website (apps/web/DEPLOY.md): the same shapes as the claude.ai
 * artifact runtime, backed by the serverless functions in apps/web/api.
 *
 * - db: documents on the server. One shared poller asks for the store's version every
 *   2 seconds while the page is visible; when it changes, everything subscribed is read again
 *   in two batched requests and a listener is called only if its content changed. A write
 *   refreshes at once, so the person who made it sees it straight away.
 * - assets: images stored on the server and served from api/blob.
 * - sample: Claude through api/claude. The API key never reaches the page.
 * - downloads: none, so files are saved with a normal browser download.
 */

export interface ServerRuntime {
  readonly db: DbLike;
  readonly assets: AssetsLike;
  readonly sample: SampleFn;
  readonly imageLimits: SampleImageLimits;
  readonly downloads: null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ServerRuntimeOptions {
  /** Used instead of the global fetch (tests). */
  readonly fetch?: FetchLike;
  /** How often to ask for the store version, in milliseconds. */
  readonly pollMs?: number;
}

export const SERVER_MAX_PROMPT_BYTES = 65_536;
const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
export const SERVER_IMAGE_LIMITS: SampleImageLimits = { maxCount: 12, maxInputBytes: 20_000_000, mediaTypes: IMAGE_TYPES };
const POLL_MS = 2_000;

type Tier = NonNullable<SampleOptions['modelTier']>;
type Body = Record<string, unknown>;

/** What every call rejects with: { code, message }, plus the answer's text for invalid_json. */
export class ServerRuntimeError extends Error implements DbError {
  readonly code: string;
  readonly text?: string;

  constructor(code: string, message: string, text?: string) {
    super(message);
    this.name = 'ServerRuntimeError';
    this.code = code;
    if (text !== undefined) this.text = text;
  }
}

function isRecord(v: unknown): v is Body {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

function codeForStatus(status: number): string {
  if (status === 401) return 'access_code';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'not_configured';
  return 'upstream_error';
}

function toError(e: unknown): ServerRuntimeError {
  if (e instanceof ServerRuntimeError) return e;
  return new ServerRuntimeError('upstream_error', e instanceof Error ? e.message : String(e));
}

/** The first bytes of an image say what it is; a declared type can be wrong or missing. */
function sniffImage(bytes: Uint8Array): string | null {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  return null;
}

function declaredType(type: string | undefined): string {
  return (type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Reads a model's JSON answer the way the claude.ai runtime does: the whole text; else the
 * body of a Markdown code fence; else from the first { or [ to the last } or ].
 */
export function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const attempt = (s: string): { ok: true; value: unknown } | null => {
    try {
      return { ok: true, value: JSON.parse(s) as unknown };
    } catch {
      return null;
    }
  };
  const whole = text.trim();
  if (!whole) return { ok: false };
  const direct = attempt(whole);
  if (direct) return direct;
  const fence = /```[^\n`]*\n?([\s\S]*?)```/.exec(whole);
  const fenced = fence?.[1] !== undefined ? attempt(fence[1].trim()) : null;
  if (fenced) return fenced;
  const starts = [whole.indexOf('{'), whole.indexOf('[')].filter((i) => i >= 0);
  const end = Math.max(whole.lastIndexOf('}'), whole.lastIndexOf(']'));
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const sliced = end > start ? attempt(whole.slice(start, end + 1)) : null;
    if (sliced) return sliced;
  }
  return { ok: false };
}

// Requests -----------------------------------------------------------------------------------

interface RequestSpec {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly body?: BodyInit;
  readonly contentType?: string;
  readonly signal?: AbortSignal | undefined;
}

type Requester = (path: string, spec: RequestSpec) => Promise<unknown>;

function createRequester(root: string, accessCode: string | null, doFetch: FetchLike): Requester {
  return async (path, spec) => {
    const cancelled = (): ServerRuntimeError => new ServerRuntimeError('cancelled', 'Cancelled.');
    if (spec.signal?.aborted) throw cancelled();
    const headers: Record<string, string> = {};
    if (spec.contentType) headers['content-type'] = spec.contentType;
    if (accessCode) headers['x-domesday-code'] = accessCode;
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${root}/${path}`, {
        method: spec.method,
        headers,
        ...(spec.body !== undefined ? { body: spec.body } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
      text = await res.text();
    } catch (e) {
      if (spec.signal?.aborted || isAbort(e)) throw cancelled();
      throw new ServerRuntimeError('unavailable', "The Domesday server couldn't be reached. Check the connection and try again.");
    }
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
    }
    if (!res.ok) {
      const p = isRecord(payload) ? payload : {};
      throw new ServerRuntimeError(typeof p.code === 'string' ? p.code : codeForStatus(res.status), typeof p.message === 'string' ? p.message : `The server answered ${res.status}.`);
    }
    if (!isRecord(payload)) throw new ServerRuntimeError('upstream_error', 'The server sent an answer that could not be read.');
    return payload;
  };
}

// Snapshots ------------------------------------------------------------------------------------

function lastSegment(path: string): string {
  return path.split('/').pop() ?? '';
}

function serialiseDoc(data: unknown): string {
  return JSON.stringify(isRecord(data) ? data : null);
}

function serialiseRows(rows: unknown): string {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r): r is { id: string; data: Json } => isRecord(r) && typeof r.id === 'string' && isRecord(r.data))
    .map((r): [string, Json] => [r.id, r.data])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(list);
}

function docSnap(path: string, serialised: string): DocSnap {
  const parsed = JSON.parse(serialised) as Json | null;
  const data = parsed ? (Object.freeze(parsed) as Json) : undefined;
  return { id: lastSegment(path), exists: data !== undefined, data: () => data };
}

function querySnap(serialised: string): QuerySnap {
  const rows = JSON.parse(serialised) as [string, Json][];
  return {
    docs: rows.map(([id, d]): DocSnap => {
      const data = Object.freeze(d) as Json;
      return { id, exists: true, data: () => data };
    }),
  };
}

type Kind = 'doc' | 'coll';

interface Listener {
  readonly next: (serialised: string) => void;
  readonly error: ((e: DbError) => void) | undefined;
  delivered: string | undefined;
}

interface Entry {
  readonly kind: Kind;
  readonly path: string;
  readonly listeners: Set<Listener>;
  /** The content as last read from the server, serialised; undefined until the first read. */
  current: string | undefined;
}

type DbCall = (body: Body) => Promise<Body>;

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // A listener's bug must not stop the others; report it where it can be seen.
    setTimeout(() => {
      throw err;
    });
  }
}

/** One poller for every subscription of a runtime. */
class SnapshotHub {
  private readonly entries: Record<Kind, Map<string, Entry>> = { doc: new Map(), coll: new Map() };
  private readonly needs = new Set<Entry>();
  private readonly call: DbCall;
  private readonly pollMs: number;
  private full = false;
  private fetching = false;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private pollAgain = false;
  private lastVersion: number | null = null;
  private watchingVisibility = false;

  constructor(call: DbCall, pollMs: number) {
    this.call = call;
    this.pollMs = pollMs;
  }

  subscribe(kind: Kind, path: string, next: (serialised: string) => void, error: ((e: DbError) => void) | undefined): Unsubscribe {
    const map = this.entries[kind];
    let entry = map.get(path);
    if (!entry) {
      entry = { kind, path, listeners: new Set(), current: undefined };
      map.set(path, entry);
      this.needs.add(entry);
      this.scheduleFetch();
    }
    const tracked = entry;
    const listener: Listener = { next, error, delivered: undefined };
    tracked.listeners.add(listener);
    // Already followed and kept up to date by the poller: answer straight away.
    if (tracked.current !== undefined) queueMicrotask(() => this.deliver(tracked, listener));
    this.start();
    return () => {
      tracked.listeners.delete(listener);
      if (tracked.listeners.size === 0 && map.get(path) === tracked) {
        map.delete(path);
        this.needs.delete(tracked);
      }
      if (!this.hasSubscriptions()) this.stopTimer();
    };
  }

  /** A write went through: read everything subscribed again now, without waiting for the next poll. */
  wrote(): void {
    this.full = true;
    this.scheduleFetch();
  }

  private hasSubscriptions(): boolean {
    return this.entries.doc.size + this.entries.coll.size > 0;
  }

  private deliver(entry: Entry, listener: Listener): void {
    const s = entry.current;
    if (s === undefined || listener.delivered === s || !entry.listeners.has(listener)) return;
    listener.delivered = s;
    safely(() => listener.next(s));
  }

  private apply(entry: Entry | undefined, serialised: string): void {
    if (!entry) return;
    entry.current = serialised;
    for (const l of [...entry.listeners]) this.deliver(entry, l);
  }

  private scheduleFetch(): void {
    // A fetch that is running looks again when it finishes.
    if (this.fetchTimer !== null || this.fetching) return;
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      void this.refresh();
    }, 0);
  }

  /** Reads what needs reading: new subscriptions, or everything after a change. Two requests at most. */
  private async refresh(): Promise<void> {
    if (this.fetching) return;
    const tracked = [...this.entries.doc.values(), ...this.entries.coll.values()];
    const targets = this.full ? tracked : tracked.filter((e) => this.needs.has(e));
    const complete = targets.length === tracked.length;
    this.full = false;
    this.needs.clear();
    if (targets.length === 0) return;
    this.fetching = true;
    let failed = false;
    try {
      const docPaths = targets.filter((e) => e.kind === 'doc').map((e) => e.path);
      const collPaths = targets.filter((e) => e.kind === 'coll').map((e) => e.path);
      const [docs, colls] = await Promise.all([
        docPaths.length > 0 ? this.call({ op: 'getMany', paths: docPaths }) : null,
        collPaths.length > 0 ? this.call({ op: 'list', paths: collPaths }) : null,
      ]);
      const versions: number[] = [];
      if (docs) {
        versions.push(Number(docs.version));
        const found = isRecord(docs.docs) ? docs.docs : {};
        for (const p of docPaths) this.apply(this.entries.doc.get(p), serialiseDoc(found[p]));
      }
      if (colls) {
        versions.push(Number(colls.version));
        const found = isRecord(colls.collections) ? colls.collections : {};
        for (const p of collPaths) this.apply(this.entries.coll.get(p), serialiseRows(found[p]));
      }
      // Everything followed was read at this version or later.
      if (complete && versions.every(Number.isFinite)) this.lastVersion = Math.min(...versions);
    } catch (e) {
      failed = true;
      // Read everything again on the next poll.
      this.full = true;
      const err = toError(e);
      for (const t of targets) for (const l of t.listeners) if (l.error) safely(() => l.error?.(err));
    } finally {
      this.fetching = false;
      if (!failed && (this.full || this.needs.size > 0)) this.scheduleFetch();
    }
  }

  private async poll(): Promise<void> {
    if (!this.hasSubscriptions()) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      const res = await this.call({ op: 'version' });
      if (Number(res.version) !== this.lastVersion) this.full = true;
      if (this.full || this.needs.size > 0) this.scheduleFetch();
    } catch {
      // Offline or the server is busy: the next tick tries again.
    } finally {
      this.polling = false;
      if (this.pollAgain) {
        this.pollAgain = false;
        void this.poll();
      }
    }
  }

  private start(): void {
    if (!this.watchingVisibility && typeof document !== 'undefined') {
      this.watchingVisibility = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.stopTimer();
        } else if (this.hasSubscriptions()) {
          this.startTimer();
          void this.poll();
        }
      });
    }
    if (typeof document === 'undefined' || !document.hidden) this.startTimer();
  }

  private startTimer(): void {
    if (this.pollTimer === null) this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
  }

  private stopTimer(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

// The runtime ----------------------------------------------------------------------------------

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  const r = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return `${Date.now().toString(36)}${r.toString(36).padStart(7, '0')}${idCounter.toString(36)}`;
}

export function createServerRuntime(base: string, accessCode: string | null, options: ServerRuntimeOptions = {}): ServerRuntime {
  const root = base.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const request = createRequester(root, accessCode, doFetch);
  const dbCall: DbCall = async (body) => (await request('db', { method: 'POST', body: JSON.stringify(body), contentType: 'application/json' })) as Body;
  const hub = new SnapshotHub(dbCall, options.pollMs ?? POLL_MS);
  const blobUrl = (id: string): string => `${root}/blob?id=${encodeURIComponent(id)}`;

  const doc = (path: string): DocRef => {
    if (path.split('/').length % 2 !== 0) throw new TypeError(`"${path}" is not a document path`);
    return {
      id: lastSegment(path),
      path,
      get: async () => docSnap(path, serialiseDoc((await dbCall({ op: 'get', path })).data)),
      set: async (data) => {
        await dbCall({ op: 'set', path, data });
        hub.wrote();
      },
      update: async (data) => {
        await dbCall({ op: 'update', path, data });
        hub.wrote();
      },
      delete: async () => {
        await dbCall({ op: 'delete', path });
        hub.wrote();
      },
      onSnapshot: (next, error) => hub.subscribe('doc', path, (s) => next(docSnap(path, s)), error),
    };
  };

  const collection = (path: string): CollRef => {
    if (path.split('/').length % 2 !== 1) throw new TypeError(`"${path}" is not a collection path`);
    return {
      path,
      doc: (id?: string) => doc(`${path}/${id ?? newId()}`),
      get: async () => querySnap(serialiseRows((await dbCall({ op: 'list', path })).docs)),
      onSnapshot: (next, error) => hub.subscribe('coll', path, (s) => next(querySnap(s)), error),
    };
  };

  const assets: AssetsLike = {
    async upload(blob, opts) {
      const sniffed = sniffImage(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
      const contentType = sniffed ?? (declaredType(opts?.type || blob.type) || 'application/octet-stream');
      const res = (await request('assets', { method: 'POST', body: blob, contentType })) as Body;
      const id = String(res.id);
      return { id, url: blobUrl(id), sizeBytes: Number(res.sizeBytes), contentType: String(res.contentType) };
    },
    async list() {
      const res = (await request('assets', { method: 'GET' })) as Body;
      const rows = (Array.isArray(res.assets) ? res.assets : []).filter(isRecord);
      return {
        assets: rows.map((a) => ({ id: String(a.id), url: blobUrl(String(a.id)), contentType: String(a.contentType), sizeBytes: Number(a.sizeBytes), createdAt: String(a.createdAt) })),
      };
    },
    async delete(ref) {
      const id = /[0-9a-f]{32}/.exec(ref)?.[0];
      if (!id) throw new ServerRuntimeError('invalid_argument', `"${ref}" is not a stored image.`);
      const res = (await request(`assets?id=${id}`, { method: 'DELETE' })) as Body;
      return { deleted: res.deleted === true };
    },
  };

  async function encodeImages(images: readonly Blob[], signal: AbortSignal | undefined): Promise<{ mediaType: string; data: string }[]> {
    if (images.length > SERVER_IMAGE_LIMITS.maxCount) throw new ServerRuntimeError('too_many_images', `Claude can look at ${SERVER_IMAGE_LIMITS.maxCount} images at a time.`);
    const out: { mediaType: string; data: string }[] = [];
    for (const [i, blob] of images.entries()) {
      if (blob.size > SERVER_IMAGE_LIMITS.maxInputBytes) throw new ServerRuntimeError('image_rejected', `Image ${i + 1} is larger than 20 MB.`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (signal?.aborted) throw new ServerRuntimeError('cancelled', 'Cancelled.');
      const declared = declaredType(blob.type);
      const mediaType = sniffImage(bytes) ?? (IMAGE_TYPES.includes(declared) ? declared : null);
      if (!mediaType) throw new ServerRuntimeError('image_rejected', `Image ${i + 1} is not a JPEG, PNG or WebP image.`);
      out.push({ mediaType, data: toBase64(bytes) });
    }
    return out;
  }

  async function run(input: string, opts: SampleOptions | undefined, asJson: boolean): Promise<{ text: string; truncated: boolean; modelTierApplied: Tier }> {
    const signal = opts?.signal;
    if (signal?.aborted) throw new ServerRuntimeError('cancelled', 'Cancelled.');
    if (typeof input !== 'string' || !input.trim()) throw new ServerRuntimeError('invalid_argument', 'The prompt is empty.');
    if (utf8Length(input) > SERVER_MAX_PROMPT_BYTES) throw new ServerRuntimeError('prompt_too_large', `The prompt is longer than ${SERVER_MAX_PROMPT_BYTES / 1024} KB.`);
    const tier: Tier = opts?.modelTier ?? 'default';
    const images = await encodeImages(opts?.images ?? [], signal);
    const res = (await request('claude', { method: 'POST', body: JSON.stringify({ input, images, json: asJson, tier }), contentType: 'application/json', signal })) as Body;
    if (typeof res.text !== 'string') throw new ServerRuntimeError('upstream_error', "Claude's answer could not be read.");
    const text = res.text;
    opts?.onText?.({ text, delta: text });
    return { text, truncated: res.stopReason === 'max_tokens', modelTierApplied: tier };
  }

  const sample: SampleFn = Object.assign((input: string, opts?: SampleOptions) => run(input, opts, false), {
    async json<T = unknown>(input: string, opts?: SampleOptions): Promise<T> {
      const { text } = await run(input, opts, true);
      const parsed = parseModelJson(text);
      if (!parsed.ok) throw new ServerRuntimeError('invalid_json', "Claude's answer was not valid JSON.", text);
      return parsed.value as T;
    },
    async limits() {
      return { maxPromptBytes: SERVER_MAX_PROMPT_BYTES, images: { ...SERVER_IMAGE_LIMITS, mediaTypes: [...IMAGE_TYPES] } };
    },
  });

  return { db: { doc, collection }, assets, sample, imageLimits: SERVER_IMAGE_LIMITS, downloads: null };
}
