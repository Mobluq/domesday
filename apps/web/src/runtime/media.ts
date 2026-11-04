import type { MediaRef } from '../data/types';
import type { Runtime } from './runtime';

/**
 * Frames and label shots: where they are stored and how to show them.
 * Stored as asset ids in the shared store; served at /_blob/<id> in every view.
 * Published files (the demo walk's frames, sample footage) are relative paths.
 * Without the assets capability, frames live in memory for this page load.
 */

const localBlobs = new Map<string, { blob: Blob; url: string }>();
let localCounter = 0;

export function urlFor(ref: MediaRef | null | undefined): string | null {
  if (!ref) return null;
  switch (ref.kind) {
    case 'asset':
      return `/_blob/${ref.id}`;
    case 'file':
      return ref.path;
    case 'local':
      return localBlobs.get(ref.key)?.url ?? null;
    default:
      return null;
  }
}

export async function storeImage(rt: Runtime, blob: Blob): Promise<MediaRef> {
  if (rt.assets) {
    const res = await rt.assets.upload(blob, { type: blob.type || 'image/jpeg' });
    return { kind: 'asset', id: res.id };
  }
  localCounter += 1;
  const key = `local-${Date.now().toString(36)}-${localCounter}`;
  localBlobs.set(key, { blob, url: URL.createObjectURL(blob) });
  return { kind: 'local', key };
}

/** Read stored image bytes back, for a device that runs recognition later. */
export async function blobFor(ref: MediaRef): Promise<Blob | null> {
  if (ref.kind === 'local') return localBlobs.get(ref.key)?.blob ?? null;
  const url = urlFor(ref);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (res.ok) return await res.blob();
  } catch {
    // Fall through to drawing the image.
  }
  // Same-origin images draw to a canvas without tainting it.
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')?.drawImage(img, 0, 0);
      c.toBlob((b) => resolve(b), 'image/jpeg', 0.9);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Remove uploaded assets that no document points at any more (used by Reset demo). */
export async function pruneAssets(rt: Runtime, keep: ReadonlySet<string>): Promise<number> {
  if (!rt.assets) return 0;
  const { assets } = await rt.assets.list();
  let removed = 0;
  for (const a of assets) {
    if (keep.has(a.id)) continue;
    try {
      const r = await rt.assets.delete(a.id);
      if (r.deleted) removed += 1;
    } catch {
      // Leave it; it costs only storage.
    }
  }
  return removed;
}

/** Offer a file to the viewer. Inside an artifact this goes through the downloads capability. */
export async function saveFile(rt: Runtime, filename: string, data: string | Blob, type = 'text/plain'): Promise<'saved' | 'declined' | 'unavailable'> {
  if (rt.downloads) {
    try {
      await rt.downloads.save({ filename, data });
      return 'saved';
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === 'declined' ? 'declined' : 'unavailable';
    }
  }
  try {
    const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'saved';
  } catch {
    return 'unavailable';
  }
}
