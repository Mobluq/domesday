import type { Box } from '../data/types';

/**
 * Pipeline stage 2, privacy pass (DMS-100, DMS-101): blur faces, screens and documents
 * in a frame before it is stored or shown to anyone. Each region is reduced to a coarse
 * mosaic and smoothed twice, with a margin around it.
 */
export async function blurRegions(blob: Blob, boxes: readonly Box[]): Promise<Blob> {
  if (boxes.length === 0) return blob;
  const bitmap = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d');
  if (!ctx) return blob;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');
  if (!tctx) return blob;
  for (const [bx, by, bw, bh] of boxes) {
    const padX = bw * 0.15;
    const padY = bh * 0.15;
    const x = Math.max(0, Math.floor((bx - padX) * c.width));
    const y = Math.max(0, Math.floor((by - padY) * c.height));
    const w = Math.min(c.width - x, Math.ceil((bw + 2 * padX) * c.width));
    const h = Math.min(c.height - y, Math.ceil((bh + 2 * padY) * c.height));
    if (w < 2 || h < 2) continue;
    const cells = Math.max(4, Math.round(Math.max(w, h) / 18));
    tmp.width = Math.max(1, Math.round((w / Math.max(w, h)) * cells));
    tmp.height = Math.max(1, Math.round((h / Math.max(w, h)) * cells));
    for (let pass = 0; pass < 2; pass += 1) {
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(c, x, y, w, h, 0, 0, tmp.width, tmp.height);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    }
  }
  return new Promise((resolve) => c.toBlob((b) => resolve(b ?? blob), 'image/jpeg', 0.86));
}
