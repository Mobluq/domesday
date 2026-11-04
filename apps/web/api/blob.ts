import { getAsset, isAssetId } from './_lib/assets.js';
import { HttpError, checkAccess, errorResponse } from './_lib/http.js';
import { redisFromEnv } from './_lib/redis.js';

/**
 * GET /api/blob?id=<asset id>: the stored image. Ids are random and an image never changes
 * once stored, so it can be cached for good. The page shows these through <img src>, which
 * cannot send headers, so the access code may also come from the cookie the page sets.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = checkAccess(request, { allowCookie: true });
  if (denied) return denied;
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!isAssetId(id)) throw new HttpError(400, 'invalid_argument', 'Give the id of a stored image.');
    const asset = await getAsset(redisFromEnv(), id);
    if (!asset) throw new HttpError(404, 'not_found', 'There is no stored image with that id.');
    return new Response(asset.bytes, {
      status: 200,
      headers: {
        'content-type': asset.contentType,
        'content-length': String(asset.bytes.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
