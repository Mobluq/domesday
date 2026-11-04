import { MAX_ASK_BODY, askBody, parseAsk, sseToText } from './_lib/ask.js';
import { ANTHROPIC_URL, ANTHROPIC_VERSION, modelFor, upstreamError, upstreamSignal } from './_lib/claude.js';
import { HttpError, checkAccess, env, errorResponse, readJson } from './_lib/http.js';

/** Long answers are rare, but leave room. vercel.json sets the same limit. */
export const maxDuration = 60;

/**
 * POST /api/ask { system, messages: [{ role, content }] }
 *   -> the answer as streamed plain text, or { code, message } with an error status.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    const apiKey = env('ANTHROPIC_API_KEY');
    if (!apiKey) throw new HttpError(503, 'not_configured', 'The assistant is not set up on this site: ANTHROPIC_API_KEY is missing.');
    const req = parseAsk(await readJson(request, MAX_ASK_BODY));
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(askBody(req, modelFor('quick'))),
        signal: upstreamSignal(request),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      throw new HttpError(timedOut ? 504 : 502, 'upstream_error', timedOut ? 'Claude took too long to answer.' : "Claude couldn't be reached.");
    }
    if (!res.ok || !res.body) throw upstreamError(res.status, await res.json().catch(() => null));
    return new Response(sseToText(res.body), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
