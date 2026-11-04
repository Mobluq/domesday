import { MAX_ASSET_BYTES, deleteAsset, imageType, isAssetId, listAssets, putAsset } from './_lib/assets.js';
import { HttpError, checkAccess, errorResponse, json, readBody } from './_lib/http.js';
import { redisFromEnv } from './_lib/redis.js';

/** POST raw image bytes (image/jpeg, image/png or image/webp, at most 2.5 MB) to store them. */
export async function POST(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    const redis = redisFromEnv();
    const type = imageType(request.headers.get('content-type'));
    if (!type) throw new HttpError(415, 'invalid_argument', 'Send a JPEG, PNG or WebP image.');
    const bytes = await readBody(request, MAX_ASSET_BYTES);
    return json(await putAsset(redis, bytes, type), 201);
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET: every stored image, oldest first, without the image data. */
export async function GET(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    return json({ assets: await listAssets(redisFromEnv()) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE ?id=<asset id> */
export async function DELETE(request: Request): Promise<Response> {
  const denied = checkAccess(request);
  if (denied) return denied;
  try {
    const redis = redisFromEnv();
    const id = new URL(request.url).searchParams.get('id');
    if (!isAssetId(id)) throw new HttpError(400, 'invalid_argument', 'Give the id of a stored image.');
    return json({ deleted: await deleteAsset(redis, id) });
  } catch (e) {
    return errorResponse(e);
  }
}
