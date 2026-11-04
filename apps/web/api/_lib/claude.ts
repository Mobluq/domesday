import { HttpError, env, isRecord } from './http.js';

/**
 * Recognition through the Anthropic Messages API for api/claude. The key stays on the
 * server (ANTHROPIC_API_KEY); the page only ever sees the answer.
 */

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_QUICK_MODEL = 'claude-haiku-5-5';
export const MAX_TOKENS = 4096;
export const MAX_CLAUDE_BODY = 4 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 65_536;
export const MAX_IMAGES = 12;
export const IMAGE_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];
/** Leaves time to answer before the function's 60 second limit. */
export const UPSTREAM_TIMEOUT_MS = 55_000;

export const JSON_SYSTEM_PROMPT =
  'A program will parse your reply as JSON. Reply with exactly one JSON value (an object or an array) and nothing else: no Markdown code fences, no comments and no text before or after it.';

export type Tier = 'quick' | 'default' | 'complex';

export interface ClaudeImage {
  readonly mediaType: string;
  readonly data: string;
}

export interface ClaudeRequest {
  readonly input: string;
  readonly images: readonly ClaudeImage[];
  readonly json: boolean;
  readonly tier: Tier;
}

export interface ClaudeResult {
  readonly text: string;
  readonly model: string;
  readonly usage: unknown;
  readonly stopReason: string | null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function modelFor(tier: Tier): string {
  if (tier === 'quick') return env('ANTHROPIC_MODEL_QUICK') ?? DEFAULT_QUICK_MODEL;
  return env('ANTHROPIC_MODEL') ?? DEFAULT_MODEL;
}

function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid_argument', message);
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseClaudeRequest(body: unknown): ClaudeRequest {
  if (!isRecord(body)) throw invalid('Send a JSON object with an input.');
  const { input, images = [], json = false, tier = 'default' } = body;
  if (typeof input !== 'string' || !input.trim()) throw invalid('input must be a non-empty string.');
  if (new TextEncoder().encode(input).byteLength > MAX_PROMPT_BYTES) throw new HttpError(413, 'too_large', `The prompt is longer than ${MAX_PROMPT_BYTES / 1024} KB.`);
  if (!Array.isArray(images)) throw invalid('images must be an array.');
  if (images.length > MAX_IMAGES) throw invalid(`Send at most ${MAX_IMAGES} images.`);
  const checked = images.map((img: unknown, i): ClaudeImage => {
    if (!isRecord(img) || typeof img.mediaType !== 'string' || typeof img.data !== 'string') throw invalid(`Image ${i + 1} needs a mediaType and base64 data.`);
    const mediaType = img.mediaType.trim().toLowerCase();
    if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new HttpError(400, 'image_rejected', `Image ${i + 1} is ${mediaType || 'of no type'}; send JPEG, PNG or WebP.`);
    if (!BASE64.test(img.data)) throw new HttpError(400, 'image_rejected', `Image ${i + 1} is not base64.`);
    return { mediaType, data: img.data };
  });
  if (typeof json !== 'boolean') throw invalid('json must be true or false.');
  if (tier !== 'quick' && tier !== 'default' && tier !== 'complex') throw invalid('tier must be quick, default or complex.');
  return { input, images: checked, json, tier };
}

/** The Messages API request: images first, then the prompt; a system prompt only for JSON answers. */
export function messagesBody(req: ClaudeRequest, model: string): Record<string, unknown> {
  const content = [
    ...req.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    { type: 'text', text: req.input },
  ];
  return {
    model,
    max_tokens: MAX_TOKENS,
    ...(req.json ? { system: JSON_SYSTEM_PROMPT } : {}),
    messages: [{ role: 'user', content }],
  };
}

function upstreamError(status: number, payload: unknown): HttpError {
  const err = isRecord(payload) && isRecord(payload.error) ? payload.error : {};
  const type = typeof err.type === 'string' ? err.type : '';
  const detail = typeof err.message === 'string' ? err.message.replace(/\s+/g, ' ').slice(0, 300) : '';
  console.error('domesday api: claude answered', status, type);
  if (status === 429 || status === 529 || type === 'rate_limit_error' || type === 'overloaded_error') {
    return new HttpError(429, 'rate_limited', 'Claude is busy right now. Wait a minute, then try again.');
  }
  if (status === 401) return new HttpError(502, 'upstream_error', 'The Anthropic API key on the server was refused. Check ANTHROPIC_API_KEY in Vercel.');
  if (status === 400 && /image/i.test(detail)) return new HttpError(400, 'image_rejected', `Claude rejected an image: ${detail}`);
  return new HttpError(502, 'upstream_error', detail ? `Claude answered ${status}: ${detail}` : `Claude answered ${status}.`);
}

export async function callClaude(
  req: ClaudeRequest,
  options: { readonly apiKey: string; readonly signal?: AbortSignal; readonly fetchImpl?: FetchLike },
): Promise<ClaudeResult> {
  const model = modelFor(req.tier);
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': options.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(messagesBody(req, model)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    throw new HttpError(timedOut ? 504 : 502, 'upstream_error', timedOut ? 'Claude took too long to answer. Try again with fewer images.' : "Claude couldn't be reached.");
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw upstreamError(res.status, payload);
  if (!isRecord(payload)) throw new HttpError(502, 'upstream_error', "Claude's answer could not be read.");
  const stopReason = typeof payload.stop_reason === 'string' ? payload.stop_reason : null;
  if (stopReason === 'refusal') throw new HttpError(422, 'refused', 'Claude declined to answer this request.');
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return { text, model: typeof payload.model === 'string' ? payload.model : model, usage: payload.usage ?? null, stopReason };
}

/** The request's own signal (the visitor left) combined with the upstream time limit. */
export function upstreamSignal(request: Request): AbortSignal {
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([request.signal, timeout]) : timeout;
}
