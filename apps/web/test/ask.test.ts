/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as askApi from '../api/ask';
import { askBody, parseAsk, sseToText } from '../api/_lib/ask';
import { buildInventoryContext, suggestions } from '../src/ai/ask';
import type { AppData, WalkBundle } from '../src/data/store';
import type { Line, Register, RoomVisit, Site, Walk } from '../src/data/types';
import type { Runtime } from '../src/runtime/runtime';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  const r = s.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out + dec.decode();
    out += dec.decode(value, { stream: true });
  }
}

const delta = (text: string): string => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;

describe('the assistant endpoint', () => {
  it('Keeps the latest turns, starting and ending with a question, and merges repeats', () => {
    const r = parseAsk({
      system: 'INVENTORY',
      messages: [
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'First question' },
        { role: 'user', content: 'Asked again after an error' },
        { role: 'assistant', content: 'An answer' },
        { role: 'user', content: 'Follow-up' },
      ],
    });
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(r.messages[0]?.content).toContain('Asked again after an error');
    expect(() => parseAsk({ system: 'x', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] })).toThrow(/last message/);
    expect(() => parseAsk({ system: '', messages: [{ role: 'user', content: 'q' }] })).toThrow();
  });

  it('Asks the quick model to stream, with the inventory as a cached system block', () => {
    const b = askBody({ system: 'INVENTORY', messages: [{ role: 'user', content: 'q' }] }, 'claude-haiku-5-5') as { stream: boolean; system: { cache_control: unknown }[]; model: string };
    expect(b.stream).toBe(true);
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('Turns server-sent events into text, however the bytes are split', async () => {
    const events = `event: message_start\ndata: {"type":"message_start"}\n\n${delta('Six lines ')}${delta('were not seen.')}event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const chunks = [events.slice(0, 37), events.slice(37, 120), events.slice(120)];
    expect(await readAll(sseToText(streamOf(chunks)))).toBe('Six lines were not seen.');
  });

  it('Ends with a short note when the stream reports an error part way', async () => {
    const events = `${delta('Partial')}event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n`;
    expect(await readAll(sseToText(streamOf([events])))).toMatch(/^Partial\n\n\(The answer stopped early/);
  });
});

describe('POST /api/ask', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('Streams the answer as plain text, with the key only on the server side', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('DOMESDAY_ACCESS_CODE', 'open sesame');
    const seen: { url: string; headers: Record<string, string>; body: { stream: boolean; model: string } }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as { stream: boolean; model: string } });
      return new Response(streamOf([delta('Two chairs '), delta('in the Boardroom.'), 'event: message_stop\ndata: {"type":"message_stop"}\n\n']), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const req = (code: string | null): Request =>
      new Request('http://x/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(code ? { 'x-domesday-code': code } : {}) },
        body: JSON.stringify({ system: 'INVENTORY', messages: [{ role: 'user', content: 'How many chairs?' }] }),
      });
    expect((await askApi.POST(req(null))).status).toBe(401);
    const res = await askApi.POST(req('open sesame'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Two chairs in the Boardroom.');
    expect(seen[0]?.headers['x-api-key']).toBe('test-key');
    expect(seen[0]?.body).toMatchObject({ stream: true, model: 'claude-haiku-5-5' });
  });

  it('Passes on a refused key as a clear message', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'bad-key');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }));
    const res = await askApi.POST(new Request('http://x/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ system: 'x', messages: [{ role: 'user', content: 'q' }] }) }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toContain('ANTHROPIC_API_KEY');
  });
});

describe('the inventory the assistant reads', () => {
  const seed = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'seed.json'), 'utf8')) as { docs: Record<string, unknown> };
  const site = seed.docs['site/main'] as Site;
  const register = seed.docs['register/main'] as Register;
  const prefix = 'walks/w-2026-10-03/';
  const lines = Object.entries(seed.docs)
    .filter(([k]) => k.startsWith(`${prefix}lines/`))
    .map(([, v]) => v as Line);
  const rooms = new Map(
    Object.entries(seed.docs)
      .filter(([k]) => k.startsWith(`${prefix}rooms/`))
      .map(([, v]) => [(v as RoomVisit).roomId, v as RoomVisit]),
  );
  const bundle: WalkBundle = { walk: seed.docs['walks/w-2026-10-03'] as Walk, rooms, lines, matches: [], followups: [] };
  const data = { rt: { mode: 'local', sample: null } as unknown as Runtime, site, register, current: bundle, previous: null, reports: [], cameraChecks: [], corrections: [], loaded: true } as AppData;

  it('Includes the site, the lines with their numbers, and the register', () => {
    const text = buildInventoryContext(data);
    expect(text).toContain('SITE\nIkeja branch, Lagos');
    expect(text).toMatch(/Line 001 \| Room 204/);
    expect(text).toContain('FIXED ASSET REGISTER');
    expect(text).toContain('FA-0412');
    expect(text).toContain('RECONCILIATION WITH THE REGISTER');
  });

  it('Stays within its size limit by dropping the least useful sections', () => {
    const text = buildInventoryContext(data, 4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('SITE');
  });

  it('Suggests questions that fit the site', () => {
    const s = suggestions(data);
    expect(s.length).toBeGreaterThan(2);
    expect(s.join(' ')).toMatch(/condition|book value|register/);
  });
});
