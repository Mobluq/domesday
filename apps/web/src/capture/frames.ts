import type { ClipCheck } from '../data/types';

/**
 * Pipeline stage 3, pick frames: sample the clip, score each candidate for sharpness
 * (variance of the Laplacian) and light, keep the sharpest frame in each stretch of the
 * clip and drop near-duplicates. Runs on the phone, in one pass of seeks.
 */

export interface PickedFrame {
  readonly t: number;
  readonly blob: Blob;
  readonly w: number;
  readonly h: number;
  readonly sharpness: number;
  readonly brightness: number;
  readonly url: string;
}

export interface ClipInfo {
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameResult {
  readonly info: ClipInfo;
  readonly frames: readonly PickedFrame[];
  readonly checks: readonly ClipCheck[];
}

interface Candidate {
  t: number;
  sharpness: number;
  brightness: number;
  contrast: number;
  signature: Float32Array;
}

const SMALL_W = 160;
const MAX_EDGE = 1600;

function waitFor(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      el.removeEventListener(event, done);
      el.removeEventListener('error', fail);
      resolve();
    };
    const fail = (): void => {
      clearTimeout(timer);
      el.removeEventListener(event, done);
      el.removeEventListener('error', fail);
      reject(new Error('This video could not be read on this device.'));
    };
    const timer = setTimeout(() => {
      el.removeEventListener(event, done);
      el.removeEventListener('error', fail);
      reject(new Error(`Timed out waiting for the video (${event}).`));
    }, timeoutMs);
    el.addEventListener(event, done, { once: true });
    el.addEventListener('error', fail, { once: true });
  });
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 0.001) return;
  const p = waitFor(video, 'seeked', 4000);
  video.currentTime = t;
  await p;
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** Mean luma, spread of luma, Laplacian variance and an 8x8 signature from a small grey image. */
export function measure(data: Uint8ClampedArray, w: number, h: number): Omit<Candidate, 't'> {
  const grey = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < grey.length; i += 1, p += 4) {
    const y = 0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0);
    grey[i] = y;
    sum += y;
  }
  const mean = sum / grey.length;
  let sq = 0;
  for (const y of grey) sq += (y - mean) * (y - mean);
  const contrast = Math.sqrt(sq / grey.length);
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const v = 4 * (grey[i] ?? 0) - (grey[i - 1] ?? 0) - (grey[i + 1] ?? 0) - (grey[i - w] ?? 0) - (grey[i + w] ?? 0);
      lapSum += v;
      lapSq += v * v;
      n += 1;
    }
  }
  const lapMean = n ? lapSum / n : 0;
  const sharpness = n ? lapSq / n - lapMean * lapMean : 0;
  const signature = new Float32Array(64);
  for (let gy = 0; gy < 8; gy += 1) {
    for (let gx = 0; gx < 8; gx += 1) {
      let s = 0;
      let c = 0;
      for (let y = Math.floor((gy * h) / 8); y < Math.floor(((gy + 1) * h) / 8); y += 1) {
        for (let x = Math.floor((gx * w) / 8); x < Math.floor(((gx + 1) * w) / 8); x += 1) {
          s += grey[y * w + x] ?? 0;
          c += 1;
        }
      }
      signature[gy * 8 + gx] = c ? s / c : 0;
    }
  }
  return { sharpness, brightness: mean, contrast, signature };
}

function difference(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return d / a.length;
}

/** DMS-013, after the fact: what a person should know about the clip before relying on it. */
export function clipChecks(candidates: readonly { brightness: number; sharpness: number; contrast: number }[], durationS: number): ClipCheck[] {
  const checks: ClipCheck[] = [];
  const n = candidates.length || 1;
  const dark = candidates.filter((c) => c.brightness < 38).length / n;
  const blocked = candidates.filter((c) => c.brightness < 22 && c.contrast < 7).length / n;
  const blurred = candidates.filter((c) => c.sharpness < 12).length / n;
  if (blocked >= 0.2) checks.push({ code: 'lens_blocked', message: 'Lens blocked for part of the clip.' });
  else if (dark >= 0.4) checks.push({ code: 'too_dark', message: 'Too dark in places. Turn on the lights if labels were hard to read.' });
  if (blurred >= 0.5) checks.push({ code: 'too_fast', message: 'Much of the clip is blurred. Pan more slowly next time.' });
  if (durationS < 5) checks.push({ code: 'short', message: 'A very short clip. A typical room takes 45 to 90 seconds.' });
  return checks;
}

export async function pickFrames(
  source: Blob,
  opts: { maxFrames: number; onProgress?: (share: number) => void; signal?: AbortSignal },
): Promise<FrameResult> {
  const url = URL.createObjectURL(source);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.append(video);
  try {
    const loaded = waitFor(video, 'loadedmetadata', 20000);
    video.src = url;
    await loaded;
    if (!Number.isFinite(video.duration)) {
      const changed = waitFor(video, 'durationchange', 8000);
      video.currentTime = 1e9;
      await changed.catch(() => undefined);
    }
    if (video.readyState < 2) await waitFor(video, 'loadeddata', 6000).catch(() => undefined);
    try {
      await video.play();
      video.pause();
    } catch {
      // Some browsers refuse play() here; seeking still decodes frames.
    }
    const durationS = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;

    const small = document.createElement('canvas');
    small.width = SMALL_W;
    small.height = Math.max(2, Math.round((SMALL_W * vh) / vw));
    const sctx = small.getContext('2d', { willReadFrequently: true });
    if (!sctx) throw new Error('This device cannot draw video frames.');

    const scale = Math.min(1, MAX_EDGE / Math.max(vw, vh));
    const fw = Math.round(vw * scale);
    const fh = Math.round(vh * scale);
    const k = Math.max(1, opts.maxFrames);
    const n = Math.min(40, Math.max(k * 3, Math.round(durationS / 0.6)));
    const segBest: { score: number; cand: Candidate | null; canvas: HTMLCanvasElement }[] = Array.from({ length: k }, () => {
      const c = document.createElement('canvas');
      c.width = fw;
      c.height = fh;
      return { score: -1, cand: null, canvas: c };
    });
    const all: Candidate[] = [];

    for (let i = 0; i < n; i += 1) {
      if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      const t = Math.min(durationS - 0.05, ((i + 0.5) * durationS) / n);
      await seek(video, Math.max(0, t));
      sctx.drawImage(video, 0, 0, small.width, small.height);
      const m = measure(sctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
      const cand: Candidate = { t, ...m };
      all.push(cand);
      const seg = Math.min(k - 1, Math.floor((t / durationS) * k));
      const light = m.brightness < 30 ? 0.3 : m.brightness > 235 ? 0.6 : 1;
      const score = (m.sharpness + 1) * light * (m.contrast < 6 ? 0.2 : 1);
      const best = segBest[seg];
      if (best && score > best.score) {
        best.score = score;
        best.cand = cand;
        best.canvas.getContext('2d')?.drawImage(video, 0, 0, fw, fh);
      }
      opts.onProgress?.((i + 1) / n);
    }

    // Keep the best of each stretch, then drop near-duplicates of a frame already kept.
    const kept: { cand: Candidate; canvas: HTMLCanvasElement }[] = [];
    for (const s of segBest) {
      if (!s.cand) continue;
      const dup = kept.some((k2) => difference(k2.cand.signature, (s.cand as Candidate).signature) < 4);
      if (!dup) kept.push({ cand: s.cand, canvas: s.canvas });
    }
    const frames: PickedFrame[] = [];
    for (const { cand, canvas } of kept) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.86));
      if (!blob) continue;
      frames.push({ t: Math.round(cand.t * 10) / 10, blob, w: fw, h: fh, sharpness: Math.round(cand.sharpness), brightness: Math.round(cand.brightness), url: URL.createObjectURL(blob) });
    }
    return { info: { durationS, width: vw, height: vh }, frames, checks: clipChecks(all, durationS) };
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

/** Read a still (a label shot) and scale it to at most 2000 px on the long edge. */
export async function prepareStill(file: Blob): Promise<{ blob: Blob; w: number; h: number; url: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) throw new Error('This photo could not be read.');
  return { blob, w, h, url: URL.createObjectURL(blob) };
}
