import { MAX_CLAUDE_BODY, callClaude, parseClaudeRequest, upstreamSignal } from './_lib/claude.js';
import { HttpError, checkAccess, env, errorResponse, json, readJson } from './_lib/http.js';

/** Recognition with several images can take a while. vercel.json sets the same limit. */
export const maxDuration = 60;

/**
 * POST /api/claude { input, images?: [{ mediaType, data }], json?, tier? }
 *   -> { text, model, usage, stopReason } or { code, message }
 */
export async function POST(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    const apiKey = env('ANTHROPIC_API_KEY');
    if (!apiKey) throw new HttpError(503, 'not_configured', 'Recognition is not set up on this site: ANTHROPIC_API_KEY is missing.');
    const req = parseClaudeRequest(await readJson(request, MAX_CLAUDE_BODY));
    return json(await callClaude(req, { apiKey, signal: upstreamSignal(request) }));
  } catch (e) {
    return errorResponse(e);
  }
}
