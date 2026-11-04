/**
 * Live labels and live quality checks for the in-app camera (live-camera.tsx).
 *
 * The detector is COCO-SSD (lite MobileNet v2) on TensorFlow.js. The model is served from
 * this site (public/models/coco-ssd) and TensorFlow is imported only when the camera opens,
 * so none of it is in the main bundle. Live labels are hints that show the app is seeing the
 * room; the asset lines of record come from Claude after filming.
 *
 * Everything here except loadDetector() is pure, so it can be tested without a camera.
 */

/** [x, y, width, height] as fractions of the frame, from the top-left. */
export type FrameBox = [number, number, number, number];

export interface Detection {
  readonly categoryId: string;
  readonly label: string;
  readonly score: number;
  readonly box: FrameBox;
}

export interface Detector {
  detect(source: HTMLVideoElement | HTMLCanvasElement): Promise<Detection[]>;
}

/** Detections weaker than this are dropped. */
export const MIN_SCORE = 0.5;

// COCO classes that can be fixed assets, with the Domesday category each one suggests and a
// short label for the viewfinder. Every other class is ignored: people, consumables and
// personal belongings (bottle, cup, wine glass, cutlery, bowl, food, handbag, backpack,
// umbrella, cell phone, book, potted plant, teddy bear, scissors, toothbrush and the like),
// and things that are not in rooms (vehicles, animals, sports gear).
const COCO_TO_CATEGORY: ReadonlyMap<string, { readonly categoryId: string; readonly label: string }> = new Map([
  ['chair', { categoryId: 'stacking-chair', label: 'Chair' }],
  ['couch', { categoryId: 'sofa', label: 'Sofa' }],
  ['bed', { categoryId: 'bed', label: 'Bed' }],
  ['tv', { categoryId: 'television', label: 'Television' }],
  ['laptop', { categoryId: 'laptop', label: 'Laptop' }],
  ['refrigerator', { categoryId: 'refrigerator', label: 'Fridge' }],
  ['microwave', { categoryId: 'microwave', label: 'Microwave' }],
  ['dining table', { categoryId: 'desk', label: 'Table' }],
  ['oven', { categoryId: 'other', label: 'Oven' }],
  ['toaster', { categoryId: 'other', label: 'Toaster' }],
  ['sink', { categoryId: 'other', label: 'Sink' }],
  ['clock', { categoryId: 'other', label: 'Clock' }],
  ['keyboard', { categoryId: 'other', label: 'Keyboard' }],
  ['mouse', { categoryId: 'other', label: 'Mouse' }],
]);

/** The Domesday category and viewfinder label for a COCO class, or null when Domesday ignores it. */
export function categoryForCoco(cocoClass: string): { categoryId: string; label: string } | null {
  const hit = COCO_TO_CATEGORY.get(cocoClass.trim().toLowerCase());
  return hit ? { categoryId: hit.categoryId, label: hit.label } : null;
}

/** What COCO-SSD returns: a box in pixels of the image it was given. */
export interface RawDetection {
  readonly bbox: readonly number[];
  readonly class: string;
  readonly score: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** COCO-SSD output on a w × h image to Domesday detections: boxes as fractions, ignored classes and weak scores dropped, strongest first. */
export function toDetections(raw: readonly RawDetection[], w: number, h: number): Detection[] {
  if (!(w > 0 && h > 0)) return [];
  const out: Detection[] = [];
  for (const r of raw) {
    if (!(r.score >= MIN_SCORE)) continue;
    const cat = categoryForCoco(r.class);
    if (!cat) continue;
    const [bx = 0, by = 0, bw = 0, bh = 0] = r.bbox;
    const x0 = clamp01(bx / w);
    const y0 = clamp01(by / h);
    const x1 = clamp01((bx + bw) / w);
    const y1 = clamp01((by + bh) / h);
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ categoryId: cat.categoryId, label: cat.label, score: r.score, box: [x0, y0, x1 - x0, y1 - y0] });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------------------
// Live quality checks, on a small frame measured with frames.ts measure().

/**
 * The light thresholds match the checks made on the finished clip (clipChecks in frames.ts),
 * so the live prompts and the notes on the clip agree.
 */
export const QUALITY = Object.freeze({
  /** How often a small frame is checked. */
  everyMs: 300,
  /** Mean luma (0 to 255) below which the room is too dark. */
  darkLuma: 38,
  /** Below this mean luma and this spread of luma, the lens is taken to be covered. */
  blockedLuma: 22,
  blockedContrast: 7,
  /** Change in the 8 × 8 brightness pattern between two checks above which the camera is moving too fast. */
  fastMotion: 18,
  /** Checks in a row before a new prompt shows. */
  confirmChecks: 2,
  /** How long a prompt stays after its cause was last seen, so it can be read. */
  holdMs: 1200,
});

/** A key of UI_COPY. */
export type Prompt = 'lensBlocked' | 'tooDark' | 'slowDown';

export interface FrameStats {
  readonly brightness: number;
  readonly contrast: number;
}

export function isLensBlocked(s: FrameStats): boolean {
  return s.brightness < QUALITY.blockedLuma && s.contrast < QUALITY.blockedContrast;
}

export function isTooDark(s: FrameStats): boolean {
  return s.brightness < QUALITY.darkLuma;
}

export function isMovingTooFast(motion: number | null): boolean {
  return motion !== null && motion > QUALITY.fastMotion;
}

/** The one prompt a frame calls for, most serious first. motion is null when it should not count. */
export function assessFrame(s: FrameStats, motion: number | null): Prompt | null {
  if (isLensBlocked(s)) return 'lensBlocked';
  if (isTooDark(s)) return 'tooDark';
  if (isMovingTooFast(motion)) return 'slowDown';
  return null;
}

/**
 * How far the scene moved between two brightness signatures from measure(): the mean change
 * per cell, after removing each signature's mean so that the camera adjusting its exposure
 * does not count as movement.
 */
export function motionScore(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let d = 0;
  for (let i = 0; i < n; i += 1) d += Math.abs((a[i] ?? 0) - ma - ((b[i] ?? 0) - mb));
  return d / n;
}

export interface GuideState {
  /** The prompt on screen. */
  readonly shown: Prompt | null;
  /** When the shown prompt's cause was last seen. */
  readonly seenAt: number;
  /** A different prompt waiting for enough checks in a row. */
  readonly pending: Prompt | null;
  readonly streak: number;
}

export const GUIDE_IDLE: GuideState = Object.freeze({ shown: null, seenAt: 0, pending: null, streak: 0 });

const RANK: Readonly<Record<Prompt, number>> = { lensBlocked: 0, tooDark: 1, slowDown: 2 };

/**
 * One prompt at a time, without flicker. A new prompt needs QUALITY.confirmChecks checks in a
 * row. A prompt stays for QUALITY.holdMs after its cause was last seen. A more serious prompt
 * replaces a less serious one as soon as it is confirmed.
 */
export function settleGuide(s: GuideState, verdict: Prompt | null, now: number): GuideState {
  if (verdict !== null && verdict === s.shown) return { shown: s.shown, seenAt: now, pending: null, streak: 0 };
  const streak = verdict === null ? 0 : verdict === s.pending ? s.streak + 1 : 1;
  const expired = s.shown !== null && now - s.seenAt >= QUALITY.holdMs;
  if (verdict !== null && streak >= QUALITY.confirmChecks && (s.shown === null || expired || RANK[verdict] < RANK[s.shown])) {
    return { shown: verdict, seenAt: now, pending: null, streak: 0 };
  }
  return { shown: expired ? null : s.shown, seenAt: s.seenAt, pending: verdict, streak };
}

// ---------------------------------------------------------------------------------------
// The running tally of items spotted, and where boxes land on the viewfinder.

export interface Spotted {
  readonly categoryId: string;
  readonly label: string;
  readonly count: number;
}

/** Keyed by category and label, so a clock and a keyboard (both "other") are counted apart. */
export type Tally = ReadonlyMap<string, Spotted>;

/** Keep, for each kind of item, the most seen in any single frame. Returns the same map when nothing grew. */
export function mergeTally(tally: Tally, frame: readonly Pick<Detection, 'categoryId' | 'label'>[]): Tally {
  const counts = new Map<string, Spotted>();
  for (const d of frame) {
    const key = `${d.categoryId}|${d.label}`;
    counts.set(key, { categoryId: d.categoryId, label: d.label, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  let next: Map<string, Spotted> | null = null;
  for (const [key, s] of counts) {
    if ((tally.get(key)?.count ?? 0) >= s.count) continue;
    next ??= new Map(tally);
    next.set(key, s);
  }
  return next ?? tally;
}

/** The tally as a list, most seen first. */
export function spottedList(tally: Tally): Spotted[] {
  return [...tally.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where a box on the camera frame lands on a viewfinder that shows the frame with
 * object-fit: cover, centred. The result is in fractions of the viewfinder, clipped to it, or
 * null when less than minSide of the box is on screen.
 */
export function coverBox(box: readonly [number, number, number, number], frame: { readonly w: number; readonly h: number }, view: { readonly w: number; readonly h: number }, minSide = 0.02): ViewRect | null {
  if (!(frame.w > 0 && frame.h > 0 && view.w > 0 && view.h > 0)) return null;
  const scale = Math.max(view.w / frame.w, view.h / frame.h);
  // The frame as shown, as a multiple of the viewfinder (1 on one axis, at least 1 on the other).
  const sw = (frame.w * scale) / view.w;
  const sh = (frame.h * scale) / view.h;
  const ox = (1 - sw) / 2;
  const oy = (1 - sh) / 2;
  const x0 = clamp01(ox + box[0] * sw);
  const y0 = clamp01(oy + box[1] * sh);
  const x1 = clamp01(ox + (box[0] + box[2]) * sw);
  const y1 = clamp01(oy + (box[1] + box[3]) * sh);
  if (x1 - x0 < minSide || y1 - y0 < minSide) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface PlacedRegion {
  /** Stable from one detection to the next while the scene holds still, so boxes can glide. */
  readonly key: string;
  readonly label: string;
  readonly rect: ViewRect;
}

/** The strongest detections placed on the viewfinder, keyed by label and left-to-right order. */
export function layoutRegions(found: readonly Detection[], frame: { readonly w: number; readonly h: number }, view: { readonly w: number; readonly h: number }, max = 8): PlacedRegion[] {
  const strongest = [...found].sort((a, b) => b.score - a.score).slice(0, max);
  const seen = new Map<string, number>();
  const out: PlacedRegion[] = [];
  for (const d of strongest.sort((a, b) => a.box[0] - b.box[0])) {
    const rect = coverBox(d.box, frame, view);
    if (!rect) continue;
    const n = seen.get(d.label) ?? 0;
    seen.set(d.label, n + 1);
    out.push({ key: `${d.label}-${n}`, label: d.label, rect });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Loading the model.

/** The long edge of the image handed to the model. It resizes to 300 × 300 itself. */
const DETECT_EDGE = 400;
const MAX_BOXES = 20;

interface CocoModel {
  detect(img: HTMLVideoElement | HTMLCanvasElement, maxNumBoxes?: number, minScore?: number): Promise<RawDetection[]>;
}

function wrap(model: CocoModel): Detector {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  return {
    async detect(source) {
      const video = source instanceof HTMLVideoElement ? source : null;
      if (video && video.readyState < 2) return [];
      const sw = video ? video.videoWidth : source.width;
      const sh = video ? video.videoHeight : source.height;
      if (!sw || !sh) return [];
      const scale = Math.min(1, DETECT_EDGE / Math.max(sw, sh));
      let input: HTMLVideoElement | HTMLCanvasElement = source;
      let w = sw;
      let h = sh;
      if (scale < 1 && ctx) {
        w = Math.max(1, Math.round(sw * scale));
        h = Math.max(1, Math.round(sh * scale));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(source, 0, 0, w, h);
        input = canvas;
      }
      return toDetections(await model.detect(input, MAX_BOXES, MIN_SCORE), w, h);
    },
  };
}

async function create(): Promise<Detector | null> {
  if (typeof document === 'undefined') return null;
  // The model is about 18 MB. Leave it alone when the person has asked to save data.
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return null;
  try {
    const { loadCocoSsd } = await import('./detector-tf');
    const modelUrl = new URL(`${import.meta.env.BASE_URL}models/coco-ssd/model.json`, document.baseURI).href;
    return wrap(await loadCocoSsd(modelUrl));
  } catch (e) {
    console.warn('Live labels are off: the detector did not load.', e);
    return null;
  }
}

let loading: Promise<Detector | null> | null = null;

/**
 * The on-device detector, or null when it cannot run here (no WebGL, Data Saver on, the
 * model did not download). Loaded once and kept for the next room; a failure is retried the
 * next time the camera opens.
 */
export function loadDetector(): Promise<Detector | null> {
  loading ??= create().then((d) => {
    if (!d) loading = null;
    return d;
  });
  return loading;
}
