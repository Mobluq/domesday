import { checkAccess, errorResponse, json, readJson } from './_lib/http.js';
import { redisFromEnv } from './_lib/redis.js';
import { DocStore, runDbOp } from './_lib/store.js';

/** Room for a 256 KB document plus its path and the JSON around it. */
const MAX_BODY = 512 * 1024;

/**
 * POST /api/db { op: 'get' | 'set' | 'update' | 'delete' | 'list' | 'getMany' | 'version', path?, paths?, data? }
 * The shared document store, with the same semantics as the in-browser store.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    const store = new DocStore(redisFromEnv());
    const body = await readJson(request, MAX_BODY);
    return json(await runDbOp(store, body));
  } catch (e) {
    return errorResponse(e);
  }
}
