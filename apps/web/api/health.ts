import { modelFor } from './_lib/claude.js';
import { accessCodeRequired, env, json } from './_lib/http.js';
import { storeConfigured } from './_lib/redis.js';

/**
 * GET /api/health: what this deployment can do. Public (no access code), and it reveals
 * only which features are switched on, never a key or a token.
 */
export function GET(): Response {
  return json({
    ok: true,
    store: storeConfigured(),
    ai: env('ANTHROPIC_API_KEY') !== undefined,
    model: modelFor('default'),
    accessCodeRequired: accessCodeRequired(),
  });
}
