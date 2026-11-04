import { createHash, timingSafeEqual } from 'node:crypto';
import process from 'node:process';

/**
 * Small helpers shared by the serverless functions in api/. Files under api/_lib are not
 * served as functions (Vercel skips names that start with an underscore).
 *
 * Nothing here logs request bodies, headers or secrets: only status codes and error names.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** An environment variable, trimmed; undefined when unset or blank. Read on every call so tests can change it. */
export function env(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ code: e.code, message: e.message }, e.status);
  // Only the error's name: a message can carry a fragment of the request body.
  console.error('domesday api: unexpected error', e instanceof Error ? e.name : typeof e);
  return json({ code: 'internal', message: 'Something went wrong on the server.' }, 500);
}

// Access code -----------------------------------------------------------------------------

/** The header every endpoint except health checks when DOMESDAY_ACCESS_CODE is set. */
export const ACCESS_HEADER = 'x-domesday-code';
/** Images load through <img src>, which cannot send headers, so api/blob also accepts this cookie (set by the page). */
export const ACCESS_COOKIE = 'domesday_code';

export function accessCodeRequired(): boolean {
  return env('DOMESDAY_ACCESS_CODE') !== undefined;
}

/** Compares in constant time: both sides are hashed first, so their lengths don't leak either. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Null when the request may go ahead; otherwise the 401 response to send. */
export function checkAccess(request: Request, options: { allowCookie?: boolean } = {}): Response | null {
  const expected = env('DOMESDAY_ACCESS_CODE');
  if (expected === undefined) return null;
  const given = request.headers.get(ACCESS_HEADER)?.trim() || (options.allowCookie ? cookieValue(request, ACCESS_COOKIE)?.trim() : null) || '';
  if (given && sameSecret(given, expected)) return null;
  return json({ code: 'access_code', message: given ? 'That access code is not right.' : 'This site needs an access code.' }, 401);
}

// Request bodies --------------------------------------------------------------------------

function tooLarge(limit: number): HttpError {
  return new HttpError(413, 'too_large', `The request is larger than ${Math.round(limit / 1024)} KB.`);
}

/** Reads the whole body, refusing it as soon as it passes `limit` bytes. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  const stream = request.body as ReadableStream<Uint8Array> | null;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function readJson(request: Request, limit: number): Promise<unknown> {
  const bytes = await readBody(request, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_argument', 'The request body is not valid JSON.');
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
