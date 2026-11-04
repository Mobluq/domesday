/// <reference types="node" />
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as assetsApi from '../api/assets';
import * as blobApi from '../api/blob';
import * as claudeApi from '../api/claude';
import * as dbApi from '../api/db';
import * as healthApi from '../api/health';
import { setAssetUrlMode, urlFor } from '../src/runtime/media';
import { connectRuntime, saveAccessCode } from '../src/runtime/runtime';
import { createServerRuntime, parseModelJson, type ServerRuntime } from '../src/runtime/server';
import type { DocSnap, Json, QuerySnap } from '../src/runtime/types';

/**
 * The website runtime against the real api/ handlers, with fakes behind them: an in-memory
 * Upstash REST (/pipeline) and an Anthropic Messages API. One mocked fetch routes everything.
 */

const UPSTASH_URL = 'https://fake-upstash.test';
const UPSTASH_TOKEN = 'test-upstash-token';
const ANTHROPIC_KEY = 'test-anthropic-key';

// A fake Upstash Redis REST API ------------------------------------------------------------

class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  readonly hashes = new Map<string, Map<string, string>>();
  /** Every pipeline received, as sent. */
  readonly pipelines: string[][][] = [];

  private set(key: string): Set<string> {
    const s = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, s);
    return s;
  }

  private hash(key: string): Map<string, string> {
    const h = this.hashes.get(key) ?? new Map<string, string>();
    this.hashes.set(key, h);
    return h;
  }

  exec(command: string[]): unknown {
    const [name = '', ...args] = command;
    const a = (i: number): string => args[i] ?? '';
    switch (name.toUpperCase()) {
      case 'GET':
        return this.strings.get(a(0)) ?? null;
      case 'SET':
        this.strings.set(a(0), a(1));
        return 'OK';
      case 'MGET':
        return args.map((k) => this.strings.get(k) ?? null);
      case 'INCR': {
        const n = Number(this.strings.get(a(0)) ?? '0') + 1;
        this.strings.set(a(0), String(n));
        return n;
      }
      case 'DEL': {
        let n = 0;
        for (const k of args) {
          const hit = this.strings.delete(k) || this.sets.delete(k) || this.hashes.delete(k);
          if (hit) n += 1;
        }
        return n;
      }
      case 'SADD': {
        const s = this.set(a(0));
        const before = s.size;
        for (const m of args.slice(1)) s.add(m);
        return s.size - before;
      }
      case 'SREM': {
        const s = this.set(a(0));
        let n = 0;
        for (const m of args.slice(1)) if (s.delete(m)) n += 1;
        return n;
      }
      case 'SMEMBERS':
        return [...(this.sets.get(a(0)) ?? [])];
      case 'HSET': {
        const h = this.hash(a(0));
        let added = 0;
        for (let i = 1; i + 1 < args.length; i += 2) {
          if (!h.has(a(i))) added += 1;
          h.set(a(i), a(i + 1));
        }
        return added;
      }
      case 'HMGET':
        return args.slice(1).map((f) => this.hashes.get(a(0))?.get(f) ?? null);
      case 'HGETALL':
        return [...(this.hashes.get(a(0)) ?? new Map<string, string>()).entries()].flat();
      case 'HDEL': {
        const h = this.hash(a(0));
        let n = 0;
        for (const f of args.slice(1)) if (h.delete(f)) n += 1;
        return n;
      }
      default:
        throw new Error(`ERR unknown command '${name}'`);
    }
  }

  async handle(request: Request): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${UPSTASH_TOKEN}`) return Response.json({ error: 'WRONGPASS invalid password' }, { status: 401 });
    if (new URL(request.url).pathname !== '/pipeline' || request.method !== 'POST') return Response.json({ error: 'not found' }, { status: 404 });
    const commands = ((await request.json()) as unknown[][]).map((c) => c.map(String));
    this.pipelines.push(commands);
    return Response.json(
      commands.map((c) => {
        try {
          return { result: this.exec(c) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }),
    );
  }
}

// A fake Anthropic Messages API ----------------------------------------------------------------

interface ClaudeCall {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

class FakeClaude {
  readonly calls: ClaudeCall[] = [];
  reply: (body: Record<string, unknown>) => Response | Promise<Response> = () => FakeClaude.text('{"lines":[]}');

  static text(text: string, stopReason = 'end_turn'): Response {
    return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: stopReason, usage: { input_tokens: 10, output_tokens: 5 } });
  }

  async handle(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    this.calls.push({ headers: request.headers, body });
    return this.reply(body);
  }
}

// One network for everything --------------------------------------------------------------------

type Handler = (request: Request) => Response | Promise<Response>;

const ENDPOINTS: Record<string, Partial<Record<string, Handler>>> = {
  health: { GET: healthApi.GET },
  db: { POST: dbApi.POST },
  assets: { GET: assetsApi.GET, POST: assetsApi.POST, DELETE: assetsApi.DELETE },
  blob: { GET: blobApi.GET },
  claude: { POST: claudeApi.POST },
};

function abortable(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fail = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

function createNetwork(redis: FakeRedis, claude: FakeClaude) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let answer: Promise<Response>;
    if (url.startsWith(UPSTASH_URL)) {
      answer = redis.handle(new Request(url, init));
    } else if (url.startsWith('https://api.anthropic.com/')) {
      answer = claude.handle(new Request(url, init));
    } else {
      const m = /(?:^|\/)api\/(\w+)(\?.*)?$/.exec(url);
      const handler = m ? ENDPOINTS[m[1] ?? '']?.[init?.method ?? 'GET'] : undefined;
      if (!m) throw new TypeError(`fetch failed: ${url}`);
      answer = Promise.resolve(handler ? handler(new Request(`https://domesday.test/api/${m[1]}${m[2] ?? ''}`, init)) : new Response(null, { status: 405 }));
    }
    return Promise.race([answer, abortable(init?.signal)]);
  });
}

type Network = ReturnType<typeof createNetwork>;

/** The api/db ops the page sent, in order. */
function dbOps(net: Network): { op: string; paths?: string[] }[] {
  return net.mock.calls
    .filter(([input]) => typeof input === 'string' && input.endsWith('/db'))
    .map(([, init]) => JSON.parse(String(init?.body)) as { op: string; paths?: string[] });
}

function jpegBytes(extra = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4 + extra);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  for (let i = 4; i < bytes.length; i += 1) bytes[i] = i % 251;
  return bytes;
}

async function callApi(net: Network, path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await net(`./api/${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

function db(net: Network, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return callApi(net, 'db', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

let redis: FakeRedis;
let claude: FakeClaude;
let net: Network;
const cleanups: (() => void)[] = [];

function runtime(pollMs = 60_000, code: string | null = null): ServerRuntime {
  return createServerRuntime('./api', code, { fetch: net, pollMs });
}

function follow<S>(subscribe: (next: (s: S) => void) => () => void): S[] {
  const seen: S[] = [];
  cleanups.push(subscribe((s) => seen.push(s)));
  return seen;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const docData = (snaps: DocSnap[]): (Json | undefined)[] => snaps.map((s) => s.data());
const ids = (snaps: QuerySnap[]): string[][] => snaps.map((s) => s.docs.map((d) => d.id));

beforeEach(() => {
  redis = new FakeRedis();
  claude = new FakeClaude();
  net = createNetwork(redis, claude);
  vi.stubGlobal('fetch', net);
  for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_MODEL_QUICK', 'DOMESDAY_ACCESS_CODE']) vi.stubEnv(name, '');
  vi.stubEnv('KV_REST_API_URL', UPSTASH_URL);
  vi.stubEnv('KV_REST_API_TOKEN', UPSTASH_TOKEN);
  vi.stubEnv('ANTHROPIC_API_KEY', ANTHROPIC_KEY);
});

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setAssetUrlMode('artifact');
});

// api/db and its Redis keys -----------------------------------------------------------------

describe('api/db on a fake Upstash REST', () => {
  it('keeps documents at d:<path>, collection members at c:<path> and counts writes in v', async () => {
    expect(await db(net, { op: 'set', path: 'walks/w1', data: { name: 'October' } })).toMatchObject({ status: 200, body: { ok: true, version: 1 } });
    expect(await db(net, { op: 'set', path: 'walks/w1/lines/l1', data: { qty: 2 } })).toMatchObject({ status: 200, body: { ok: true, version: 2 } });

    expect(JSON.parse(redis.strings.get('d:walks/w1') ?? 'null')).toEqual({ name: 'October' });
    expect(JSON.parse(redis.strings.get('d:walks/w1/lines/l1') ?? 'null')).toEqual({ qty: 2 });
    expect([...(redis.sets.get('c:walks') ?? [])]).toEqual(['w1']);
    expect([...(redis.sets.get('c:walks/w1/lines') ?? [])]).toEqual(['l1']);
    expect(redis.strings.get('v')).toBe('2');
    // One round trip per write: document, membership and version together.
    expect(redis.pipelines.at(-1)?.map((c) => c[0])).toEqual(['SET', 'SADD', 'INCR']);
    expect(await db(net, { op: 'version' })).toMatchObject({ body: { version: 2 } });
  });

  it('merges updates into nested objects, replaces arrays, and needs the document to exist', async () => {
    await db(net, { op: 'set', path: 'site/main', data: { name: 'Ikeja', address: { city: 'Lagos', street: 'Allen Avenue' }, rooms: ['a', 'b'] } });
    expect(await db(net, { op: 'update', path: 'site/main', data: { address: { street: 'Obafemi Awolowo Way' }, rooms: ['c'] } })).toMatchObject({ status: 200, body: { version: 2 } });
    expect(await db(net, { op: 'get', path: 'site/main' })).toMatchObject({
      body: { data: { name: 'Ikeja', address: { city: 'Lagos', street: 'Obafemi Awolowo Way' }, rooms: ['c'] } },
    });

    const missing = await db(net, { op: 'update', path: 'site/other', data: { x: 1 } });
    expect(missing).toMatchObject({ status: 400, body: { code: 'invalid_argument', message: 'site/other does not exist' } });
    expect(redis.strings.has('d:site/other')).toBe(false);
    expect(redis.strings.get('v')).toBe('2');
  });

  it('deletes the document and its membership', async () => {
    await db(net, { op: 'set', path: 'reports/r1', data: { code: 'R1' } });
    await db(net, { op: 'set', path: 'reports/r2', data: { code: 'R2' } });
    expect(await db(net, { op: 'delete', path: 'reports/r1' })).toMatchObject({ status: 200, body: { ok: true, version: 3 } });
    expect(redis.strings.has('d:reports/r1')).toBe(false);
    expect([...(redis.sets.get('c:reports') ?? [])]).toEqual(['r2']);
    expect(await db(net, { op: 'get', path: 'reports/r1' })).toMatchObject({ status: 200, body: { data: null } });
  });

  it('lists collections sorted by id and reads several documents in one round trip', async () => {
    for (const id of ['b', 'c', 'a']) await db(net, { op: 'set', path: `walks/w1/rooms/${id}`, data: { id } });
    await db(net, { op: 'set', path: 'walks/w1/lines/l1', data: { n: 1 } });
    // A member whose document has gone (an interrupted write) is skipped.
    redis.sets.get('c:walks/w1/rooms')?.add('ghost');

    expect(await db(net, { op: 'list', path: 'walks/w1/rooms' })).toMatchObject({
      status: 200,
      body: { version: 4, docs: [{ id: 'a', data: { id: 'a' } }, { id: 'b', data: { id: 'b' } }, { id: 'c', data: { id: 'c' } }] },
    });
    const both = await db(net, { op: 'list', paths: ['walks/w1/rooms', 'walks/w1/lines', 'walks/w1/matches'] });
    expect(both.body).toEqual({
      version: 4,
      collections: { 'walks/w1/rooms': [{ id: 'a', data: { id: 'a' } }, { id: 'b', data: { id: 'b' } }, { id: 'c', data: { id: 'c' } }], 'walks/w1/lines': [{ id: 'l1', data: { n: 1 } }], 'walks/w1/matches': [] },
    });

    const before = redis.pipelines.length;
    const many = await db(net, { op: 'getMany', paths: ['walks/w1/rooms/a', 'walks/w1/lines/l1', 'site/main'] });
    expect(many.body).toEqual({ version: 4, docs: { 'walks/w1/rooms/a': { id: 'a' }, 'walks/w1/lines/l1': { n: 1 }, 'site/main': null } });
    expect(redis.pipelines.length - before).toBe(1);
  });

  it('refuses bad paths, bad data and documents over 256 KB', async () => {
    const bad = async (body: Record<string, unknown>): Promise<unknown> => (await db(net, body)).body.code;
    expect(await bad({ op: 'set', path: 'walks', data: {} })).toBe('invalid_argument');
    expect(await bad({ op: 'list', path: 'walks/w1' })).toBe('invalid_argument');
    expect(await bad({ op: 'get', path: 'walks/w 1' })).toBe('invalid_argument');
    expect(await bad({ op: 'get', path: 'walks//w1' })).toBe('invalid_argument');
    expect(await bad({ op: 'get', path: Array.from({ length: 18 }, (_, i) => `s${i}`).join('/') })).toBe('invalid_argument');
    expect(await bad({ op: 'get', path: 'a_b-c.d~e:f@g+h/i9' })).toBeUndefined();
    expect(await bad({ op: 'set', path: 'walks/w1', data: [1, 2] })).toBe('invalid_argument');
    expect(await bad({ op: 'drop', path: 'walks/w1' })).toBe('invalid_argument');
    const big = await db(net, { op: 'set', path: 'walks/w1', data: { blob: 'x'.repeat(256 * 1024) } });
    expect(big).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(redis.strings.has('d:walks/w1')).toBe(false);
  });

  it('answers 503 not_configured without a store', async () => {
    vi.stubEnv('KV_REST_API_URL', '');
    expect(await db(net, { op: 'version' })).toMatchObject({ status: 503, body: { code: 'not_configured' } });
    vi.stubEnv('UPSTASH_REDIS_REST_URL', UPSTASH_URL);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', UPSTASH_TOKEN);
    expect(await db(net, { op: 'version' })).toMatchObject({ status: 200, body: { version: 0 } });
  });
});

describe('access code', () => {
  beforeEach(() => vi.stubEnv('DOMESDAY_ACCESS_CODE', 'open sesame'));

  it('guards every endpoint but health', async () => {
    expect(await callApi(net, 'health')).toMatchObject({ status: 200, body: { ok: true, store: true, ai: true, accessCodeRequired: true } });
    expect(await db(net, { op: 'version' })).toMatchObject({ status: 401, body: { code: 'access_code' } });
    expect(await db(net, { op: 'version' }, { 'x-domesday-code': 'open says me' })).toMatchObject({ status: 401, body: { code: 'access_code' } });
    expect(await db(net, { op: 'version' }, { 'x-domesday-code': 'open sesame' })).toMatchObject({ status: 200 });
    expect(await callApi(net, 'assets')).toMatchObject({ status: 401 });
    expect(await callApi(net, 'claude', { method: 'POST', body: '{}' })).toMatchObject({ status: 401 });
    expect(await callApi(net, 'blob?id=0123456789abcdef0123456789abcdef')).toMatchObject({ status: 401 });
  });

  it('lets images load with the cookie the page sets, since <img> cannot send headers', async () => {
    const rt = runtime(60_000, 'open sesame');
    const { id } = await rt.assets.upload(new Blob([jpegBytes()], { type: 'image/jpeg' }));
    expect(await callApi(net, `blob?id=${id}`)).toMatchObject({ status: 401 });
    const res = await net(`./api/blob?id=${id}`, { headers: { cookie: `other=1; domesday_code=${encodeURIComponent('open sesame')}` } });
    expect(res.status).toBe(200);
    // The cookie is only for images: the store still wants the header.
    expect(await db(net, { op: 'version' }, { cookie: 'domesday_code=open%20sesame' })).toMatchObject({ status: 401 });
  });
});

// api/assets and api/blob ---------------------------------------------------------------------

describe('api/assets and api/blob', () => {
  it('stores an image as base64 with its type, lists it, serves it for good and deletes it', async () => {
    const bytes = jpegBytes(1000);
    const up = await callApi(net, 'assets', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: bytes });
    expect(up.status).toBe(201);
    const id = String(up.body.id);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(up.body).toMatchObject({ url: `/api/blob?id=${id}`, sizeBytes: 1004, contentType: 'image/jpeg' });
    expect(redis.hashes.get(`b:${id}`)?.get('type')).toBe('image/jpeg');
    expect(redis.hashes.get(`b:${id}`)?.get('data')).toBe(Buffer.from(bytes).toString('base64'));

    const list = await callApi(net, 'assets');
    expect(list.body.assets).toEqual([{ id, url: `/api/blob?id=${id}`, contentType: 'image/jpeg', sizeBytes: 1004, createdAt: expect.any(String) }]);

    const res = await net(`./api/blob?id=${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    expect(await callApi(net, `assets?id=${id}`, { method: 'DELETE' })).toMatchObject({ status: 200, body: { deleted: true } });
    expect(await callApi(net, `assets?id=${id}`, { method: 'DELETE' })).toMatchObject({ status: 200, body: { deleted: false } });
    expect(await callApi(net, `blob?id=${id}`)).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect((await callApi(net, 'assets')).body.assets).toEqual([]);
  });

  it('refuses other types, files that are not what they say, and images over 2.5 MB', async () => {
    expect(await callApi(net, 'assets', { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<p>hi</p>' })).toMatchObject({ status: 415 });
    expect(await callApi(net, 'assets', { method: 'POST', headers: { 'content-type': 'image/png' }, body: jpegBytes() })).toMatchObject({ status: 400, body: { code: 'invalid_argument' } });
    const huge = jpegBytes(2.5 * 1024 * 1024);
    expect(await callApi(net, 'assets', { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: huge })).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(await callApi(net, 'blob?id=../../etc')).toMatchObject({ status: 400 });
    expect(redis.hashes.size).toBe(0);
  });
});

// api/claude ------------------------------------------------------------------------------------

describe('api/claude', () => {
  it('calls the Messages API with the key, the version, images first and the JSON system prompt', async () => {
    const image = Buffer.from(jpegBytes()).toString('base64');
    const res = await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'What is here?', images: [{ mediaType: 'image/jpeg', data: image }], json: true }) });
    expect(res).toMatchObject({ status: 200, body: { text: '{"lines":[]}', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 } } });

    const call = claude.calls[0];
    expect(call?.headers.get('x-api-key')).toBe(ANTHROPIC_KEY);
    expect(call?.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
      system: expect.stringContaining('JSON'),
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text: 'What is here?' }] }],
    });
    expect(JSON.stringify(res.body)).not.toContain(ANTHROPIC_KEY);
  });

  it('picks the model by tier and leaves out the system prompt for plain text', async () => {
    await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'hi', tier: 'quick' }) });
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-opus-test');
    vi.stubEnv('ANTHROPIC_MODEL_QUICK', 'claude-quick-test');
    await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'hi', tier: 'complex' }) });
    await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'hi', tier: 'quick' }) });
    expect(claude.calls.map((c) => c.body.model)).toEqual(['claude-haiku-5-5', 'claude-opus-test', 'claude-quick-test']);
    expect(claude.calls.every((c) => !('system' in c.body))).toBe(true);
    expect(await callApi(net, 'health')).toMatchObject({ body: { model: 'claude-opus-test' } });
  });

  it('maps failures to not_configured, rate_limited, refused and upstream_error', async () => {
    const ask = (): Promise<{ status: number; body: Record<string, unknown> }> => callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'hi' }) });
    claude.reply = () => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { status: 429 });
    expect(await ask()).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
    claude.reply = () => FakeClaude.text('', 'refusal');
    expect(await ask()).toMatchObject({ body: { code: 'refused' } });
    claude.reply = () => Response.json({ type: 'error', error: { type: 'api_error', message: 'boom' } }, { status: 500 });
    expect(await ask()).toMatchObject({ status: 502, body: { code: 'upstream_error' } });
    claude.reply = () => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 });
    const auth = await ask();
    expect(auth.body.code).toBe('upstream_error');
    expect(JSON.stringify(auth.body)).not.toContain(ANTHROPIC_KEY);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(await ask()).toMatchObject({ status: 503, body: { code: 'not_configured' } });
    expect(await callApi(net, 'health')).toMatchObject({ body: { ai: false } });
  });

  it('refuses bodies over 4 MB and malformed requests', async () => {
    expect(await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'x'.repeat(4 * 1024 * 1024) }) })).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: '' }) })).toMatchObject({ status: 400 });
    expect(await callApi(net, 'claude', { method: 'POST', body: JSON.stringify({ input: 'hi', images: [{ mediaType: 'image/gif', data: 'R0lG' }] }) })).toMatchObject({ body: { code: 'image_rejected' } });
    expect(claude.calls).toHaveLength(0);
  });
});

// The page's runtime ----------------------------------------------------------------------------

describe('createServerRuntime db', () => {
  it('gets, sets, updates, deletes and lists like the in-browser store', async () => {
    const rt = runtime();
    const site = rt.db.doc('site/main');
    expect(site.id).toBe('main');
    expect((await site.get()).exists).toBe(false);
    await site.set({ name: 'Ikeja', address: { city: 'Lagos', street: 'Allen Avenue' }, rooms: ['a'] });
    await site.update({ address: { street: 'Awolowo Way' }, rooms: ['b', 'c'] });
    const snap = await site.get();
    expect(snap.exists).toBe(true);
    expect(snap.data()).toEqual({ name: 'Ikeja', address: { city: 'Lagos', street: 'Awolowo Way' }, rooms: ['b', 'c'] });
    expect(Object.isFrozen(snap.data())).toBe(true);

    await expect(rt.db.doc('site/nope').update({ a: 1 })).rejects.toMatchObject({ code: 'invalid_argument', message: 'site/nope does not exist' });

    const lines = rt.db.collection('walks/w1/lines');
    await lines.doc('l2').set({ n: 2 });
    await lines.doc('l1').set({ n: 1 });
    const made = lines.doc();
    expect(made.path).toMatch(/^walks\/w1\/lines\/[a-z0-9]+$/);
    await made.set({ n: 3 });
    const listed = await lines.get();
    expect(listed.docs.map((d) => d.id).slice(0, 2)).toEqual(['l1', 'l2']);
    expect(listed.docs).toHaveLength(3);

    await lines.doc('l1').delete();
    expect((await lines.get()).docs.map((d) => d.data()?.n).sort()).toEqual([2, 3]);
    expect(() => rt.db.doc('walks')).toThrow(TypeError);
    expect(() => rt.db.collection('walks/w1')).toThrow(TypeError);
  });

  it('delivers right after subscribing, in one batched read for everything subscribed together', async () => {
    const writer = runtime();
    await writer.db.doc('site/main').set({ name: 'Ikeja' });
    await writer.db.doc('walks/w1/rooms/r1').set({ status: 'filmed' });
    const before = dbOps(net).length;

    const rt = runtime();
    const site = follow<DocSnap>((next) => rt.db.doc('site/main').onSnapshot(next));
    const register = follow<DocSnap>((next) => rt.db.doc('register/main').onSnapshot(next));
    const rooms = follow<QuerySnap>((next) => rt.db.collection('walks/w1/rooms').onSnapshot(next));
    const lines = follow<QuerySnap>((next) => rt.db.collection('walks/w1/lines').onSnapshot(next));
    await vi.waitFor(() => expect(site.length + register.length + rooms.length + lines.length).toBe(4));

    expect(docData(site)).toEqual([{ name: 'Ikeja' }]);
    expect(register[0]?.exists).toBe(false);
    expect(ids(rooms)).toEqual([['r1']]);
    expect(ids(lines)).toEqual([[]]);
    expect(dbOps(net).slice(before)).toEqual([
      { op: 'getMany', paths: ['site/main', 'register/main'] },
      { op: 'list', paths: ['walks/w1/rooms', 'walks/w1/lines'] },
    ]);

    // A second listener on a followed path is answered from what is already known.
    const again = follow<DocSnap>((next) => rt.db.doc('site/main').onSnapshot(next));
    await vi.waitFor(() => expect(docData(again)).toEqual([{ name: 'Ikeja' }]));
    expect(dbOps(net).length - before).toBe(2);
  });

  it('polls the version, and calls a listener only when its content changed', async () => {
    const other = runtime();
    await other.db.doc('site/main').set({ name: 'Ikeja' });
    const rt = runtime(15);
    const site = follow<DocSnap>((next) => rt.db.doc('site/main').onSnapshot(next));
    const rooms = follow<QuerySnap>((next) => rt.db.collection('walks/w1/rooms').onSnapshot(next));
    await vi.waitFor(() => expect(site.length + rooms.length).toBe(2));

    // Another device changes something nobody here follows: the version moves, nothing is delivered.
    const mark = dbOps(net).length;
    await other.db.doc('register/main').set({ items: [] });
    await vi.waitFor(() => expect(dbOps(net).slice(mark).some((o) => o.op === 'getMany')).toBe(true));
    await sleep(60);
    expect(site).toHaveLength(1);
    expect(rooms).toHaveLength(1);

    // Another device changes a followed document and adds to a followed collection.
    await other.db.doc('site/main').update({ name: 'Ikeja branch' });
    await other.db.doc('walks/w1/rooms/r1').set({ status: 'filmed' });
    await vi.waitFor(() => {
      expect(docData(site).at(-1)).toEqual({ name: 'Ikeja branch' });
      expect(ids(rooms).at(-1)).toEqual(['r1']);
    });
    const deliveries = site.length + rooms.length;
    await sleep(60);
    expect(site.length + rooms.length).toBe(deliveries);
  });

  it("shows the writer's own write at once, without waiting for a poll", async () => {
    const rt = runtime(60_000);
    const lines = follow<QuerySnap>((next) => rt.db.collection('walks/w1/lines').onSnapshot(next));
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    await rt.db.collection('walks/w1/lines').doc('l1').set({ n: 1 });
    await vi.waitFor(() => expect(ids(lines)).toEqual([[], ['l1']]), { timeout: 500 });
    expect(dbOps(net).some((o) => o.op === 'version')).toBe(false);
  });

  it('stops after unsubscribing and pauses while the page is hidden', async () => {
    const page = Object.assign(new EventTarget(), { hidden: true });
    vi.stubGlobal('document', page);
    const other = runtime();
    const rt = runtime(10);
    const seen: DocSnap[] = [];
    const stop = rt.db.doc('site/main').onSnapshot((s) => seen.push(s));
    cleanups.push(stop);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await other.db.doc('site/main').set({ name: 'Ikeja' });
    await sleep(60);
    expect(dbOps(net).filter((o) => o.op === 'version')).toHaveLength(0);
    expect(seen).toHaveLength(1);

    page.hidden = false;
    page.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(docData(seen).at(-1)).toEqual({ name: 'Ikeja' }));

    stop();
    const polls = dbOps(net).filter((o) => o.op === 'version').length;
    await other.db.doc('site/main').set({ name: 'Changed' });
    await sleep(60);
    expect(dbOps(net).filter((o) => o.op === 'version').length).toBe(polls);
    expect(seen).toHaveLength(2);
  });

  it('rejects with { code, message } when the server cannot be reached', async () => {
    const offline = createServerRuntime('./api', null, { fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(offline.db.doc('site/main').get()).rejects.toMatchObject({ code: 'unavailable', message: expect.any(String) });
  });
});

describe('createServerRuntime assets', () => {
  it('uploads, lists and deletes images, with URLs under the API base', async () => {
    const rt = runtime();
    const up = await rt.assets.upload(new Blob([jpegBytes()]), { type: 'image/jpeg' });
    expect(up).toMatchObject({ url: `./api/blob?id=${up.id}`, sizeBytes: 68, contentType: 'image/jpeg' });
    expect((await rt.assets.list()).assets.map((a) => a.url)).toEqual([up.url]);
    expect(await rt.assets.delete(up.id)).toEqual({ deleted: true });
    expect((await rt.assets.list()).assets).toEqual([]);
  });
});

describe('createServerRuntime sample', () => {
  it('sends the prompt and images as base64, calls onText once and reports the tier', async () => {
    const rt = runtime();
    const bytes = jpegBytes(100);
    const updates: string[] = [];
    claude.reply = () => FakeClaude.text('A plain answer.');
    const res = await rt.sample('Describe this.', { images: [new Blob([bytes])], modelTier: 'quick', onText: ({ text }) => updates.push(text) });
    expect(res).toEqual({ text: 'A plain answer.', truncated: false, modelTierApplied: 'quick' });
    expect(updates).toEqual(['A plain answer.']);
    expect(claude.calls[0]?.body).toMatchObject({
      model: 'claude-haiku-5-5',
      messages: [{ content: [{ type: 'image', source: { media_type: 'image/jpeg', data: Buffer.from(bytes).toString('base64') } }, { type: 'text', text: 'Describe this.' }] }],
    });
    expect(await rt.sample.limits()).toEqual({ maxPromptBytes: 65536, images: { maxCount: 12, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } });
  });

  it('parses JSON answers tolerantly and rejects invalid_json with the text', async () => {
    const rt = runtime();
    const answers = [
      ['{"lines":[1]}', { lines: [1] }],
      ['Here you are:\n```json\n{"lines":[2]}\n```\nThat is all.', { lines: [2] }],
      ['Sure! {"lines":[3]} Hope that helps.', { lines: [3] }],
      ['Two lists: [1, 2] and done', [1, 2]],
    ] as const;
    for (const [text, value] of answers) {
      claude.reply = () => FakeClaude.text(text);
      expect(await rt.sample.json(text)).toEqual(value);
    }
    expect(claude.calls.every((c) => typeof c.body.system === 'string')).toBe(true);

    claude.reply = () => FakeClaude.text('I could not see any assets.');
    await expect(rt.sample.json('x')).rejects.toMatchObject({ code: 'invalid_json', message: expect.any(String), text: 'I could not see any assets.' });
    expect(parseModelJson('```\n[]\n```')).toEqual({ ok: true, value: [] });
    expect(parseModelJson('{ broken')).toEqual({ ok: false });
  });

  it('rejects with the server error codes, and with cancelled when the signal aborts', async () => {
    const rt = runtime();
    claude.reply = () => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 });
    await expect(rt.sample.json('x')).rejects.toMatchObject({ code: 'rate_limited' });
    claude.reply = () => FakeClaude.text('', 'refusal');
    await expect(rt.sample.json('x')).rejects.toMatchObject({ code: 'refused' });
    claude.reply = () => FakeClaude.text('{"partial": ', 'max_tokens');
    await expect(rt.sample('x')).resolves.toMatchObject({ truncated: true });

    const early = new AbortController();
    early.abort();
    await expect(rt.sample.json('x', { signal: early.signal })).rejects.toMatchObject({ code: 'cancelled' });

    claude.reply = () => new Promise<Response>(() => undefined);
    const ctl = new AbortController();
    const pending = rt.sample.json('x', { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });

    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(rt.sample('x')).rejects.toMatchObject({ code: 'not_configured' });
    await expect(rt.sample('x', { images: [new Blob(['GIF89a'], { type: 'image/gif' })] })).rejects.toMatchObject({ code: 'image_rejected' });
  });
});

// connectRuntime off claude.ai ----------------------------------------------------------------

describe('connectRuntime on the website', () => {
  let storage: Map<string, string>;
  let page: { cookie: string; hidden: boolean; addEventListener: () => void };

  beforeEach(() => {
    storage = new Map();
    page = { cookie: '', hidden: false, addEventListener: () => undefined };
    vi.stubGlobal('window', { location: { protocol: 'https:' } });
    vi.stubGlobal('document', page);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
  });

  it('uses the server when health reports a store, without seeding it', async () => {
    const rt = await connectRuntime();
    expect(rt).toMatchObject({ mode: 'server', shared: true, ai: true, needsAccessCode: false, seededLocally: false, downloads: null });
    expect(rt.sample).not.toBeNull();
    expect(rt.imageLimits?.maxCount).toBe(12);
    expect(urlFor({ kind: 'asset', id: 'abc' })).toBe('./api/blob?id=abc');
    expect((await rt.db.doc('site/main').get()).exists).toBe(false);
    expect(redis.strings.size).toBe(0);
  });

  it('turns recognition off when the server has no key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const rt = await connectRuntime();
    expect(rt).toMatchObject({ mode: 'server', ai: false, sample: null, imageLimits: null });
  });

  it('falls back to the local store when there is no API or no store', async () => {
    vi.stubEnv('KV_REST_API_URL', '');
    const rt = await connectRuntime();
    expect(rt).toMatchObject({ mode: 'local', shared: false, ai: false, needsAccessCode: false });
    expect(urlFor({ kind: 'asset', id: 'abc' })).toBe('/_blob/abc');
  });

  it('asks for the access code until a saved one is accepted', async () => {
    vi.stubEnv('DOMESDAY_ACCESS_CODE', 'open sesame');
    expect(await connectRuntime()).toMatchObject({ mode: 'server', needsAccessCode: true, ai: false, sample: null });

    saveAccessCode('wrong');
    expect(await connectRuntime()).toMatchObject({ needsAccessCode: true });

    saveAccessCode('  open sesame ');
    expect(storage.get('domesday.accessCode')).toBe('open sesame');
    const rt = await connectRuntime();
    expect(rt).toMatchObject({ needsAccessCode: false, ai: true });
    expect(page.cookie).toContain('domesday_code=open%20sesame');
    expect(page.cookie).toContain('SameSite=Strict');
    await rt.db.doc('site/main').set({ name: 'Ikeja' });
    expect((await rt.db.doc('site/main').get()).data()).toEqual({ name: 'Ikeja' });

    saveAccessCode('');
    expect(storage.has('domesday.accessCode')).toBe(false);
    expect(page.cookie).toContain('Max-Age=0');
  });
});
