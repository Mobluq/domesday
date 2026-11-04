import { UI_COPY } from '@domesday/domain';
import { describe, expect, it } from 'vitest';
import {
  assessFrame,
  categoryForCoco,
  coverBox,
  GUIDE_IDLE,
  isLensBlocked,
  isMovingTooFast,
  isTooDark,
  layoutRegions,
  mergeTally,
  MIN_SCORE,
  motionScore,
  QUALITY,
  settleGuide,
  spottedList,
  toDetections,
  type Detection,
  type GuideState,
  type Prompt,
  type Tally,
} from '../src/capture/detector';
import { measure } from '../src/capture/frames';
import { pickMimeType } from '../src/capture/live-camera';

/** A grey RGBA frame from a luma function. */
function frame(w: number, h: number, luma: (x: number, y: number) => number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const v = luma(x, y);
      const p = (y * w + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return data;
}

const W = 160;
const H = 90;
/** Vertical stripes 40 px wide, shifted by dx: a scene with large shapes. */
const stripes = (dx: number, lo = 40, hi = 220) => frame(W, H, (x) => (Math.floor((x + dx) / 40) % 2 === 0 ? lo : hi));

function det(label: string, categoryId: string, box: [number, number, number, number], score = 0.9): Detection {
  return { categoryId, label, score, box };
}

describe('COCO classes to Domesday categories', () => {
  it.each([
    ['chair', 'stacking-chair', 'Chair'],
    ['couch', 'sofa', 'Sofa'],
    ['bed', 'bed', 'Bed'],
    ['tv', 'television', 'Television'],
    ['laptop', 'laptop', 'Laptop'],
    ['refrigerator', 'refrigerator', 'Fridge'],
    ['microwave', 'microwave', 'Microwave'],
    ['dining table', 'desk', 'Table'],
  ])('maps %s to %s', (coco, categoryId, label) => {
    expect(categoryForCoco(coco)).toEqual({ categoryId, label });
  });

  it.each([
    ['oven', 'Oven'],
    ['toaster', 'Toaster'],
    ['sink', 'Sink'],
    ['clock', 'Clock'],
    ['keyboard', 'Keyboard'],
    ['mouse', 'Mouse'],
  ])('maps %s to other, labelled by its COCO name', (coco, label) => {
    expect(categoryForCoco(coco)).toEqual({ categoryId: 'other', label });
  });

  it.each([
    'person',
    'bottle',
    'cup',
    'wine glass',
    'fork',
    'knife',
    'spoon',
    'bowl',
    'banana',
    'pizza',
    'cake',
    'handbag',
    'backpack',
    'umbrella',
    'cell phone',
    'book',
    'potted plant',
    'teddy bear',
    'scissors',
    'toothbrush',
    'car',
    'dog',
  ])('ignores %s', (coco) => {
    expect(categoryForCoco(coco)).toBeNull();
  });

  it('is forgiving about case and space, and not fooled by object keys', () => {
    expect(categoryForCoco(' Dining Table ')).toEqual({ categoryId: 'desk', label: 'Table' });
    expect(categoryForCoco('constructor')).toBeNull();
    expect(categoryForCoco('toString')).toBeNull();
  });

  it('turns pixel boxes into fractions and drops weak and ignored detections', () => {
    const out = toDetections(
      [
        { bbox: [100, 45, 80, 90], class: 'chair', score: 0.62 },
        { bbox: [0, 0, 50, 50], class: 'person', score: 0.99 },
        { bbox: [10, 10, 50, 50], class: 'tv', score: MIN_SCORE - 0.01 },
        { bbox: [380, -10, 40, 30], class: 'clock', score: 0.8 },
      ],
      400,
      225,
    );
    expect(out.map((d) => d.label)).toEqual(['Clock', 'Chair']);
    const [clock, chair] = out;
    expect(chair?.categoryId).toBe('stacking-chair');
    expect(chair?.box[0]).toBeCloseTo(0.25);
    expect(chair?.box[1]).toBeCloseTo(0.2);
    expect(chair?.box[2]).toBeCloseTo(0.2);
    expect(chair?.box[3]).toBeCloseTo(0.4);
    // Clipped to the frame.
    expect(clock?.box[0]).toBeCloseTo(0.95);
    expect(clock?.box[1]).toBe(0);
    expect(clock?.box[2]).toBeCloseTo(0.05);
    expect(clock?.box[3]).toBeCloseTo(20 / 225);
    expect(toDetections([{ bbox: [0, 0, 1, 1], class: 'bed', score: 0.9 }], 0, 0)).toEqual([]);
  });
});

describe('live quality checks', () => {
  it('has a prompt in UI_COPY for every decision', () => {
    const prompts: Prompt[] = ['lensBlocked', 'tooDark', 'slowDown'];
    expect(prompts.map((p) => UI_COPY[p])).toEqual(['Lens blocked', 'Too dark, turn on the lights', 'Slow down']);
  });

  it('calls a dark frame with almost no spread of light a blocked lens', () => {
    expect(isLensBlocked({ brightness: 6, contrast: 1 })).toBe(true);
    expect(isLensBlocked({ brightness: 6, contrast: QUALITY.blockedContrast + 4 })).toBe(false);
    expect(isLensBlocked({ brightness: 120, contrast: 1 })).toBe(false);
    expect(assessFrame({ brightness: 6, contrast: 1 }, 40)).toBe('lensBlocked');
  });

  it('calls a frame with low mean luma too dark', () => {
    expect(isTooDark({ brightness: QUALITY.darkLuma - 1, contrast: 30 })).toBe(true);
    expect(isTooDark({ brightness: QUALITY.darkLuma, contrast: 30 })).toBe(false);
    expect(assessFrame({ brightness: 30, contrast: 20 }, 40)).toBe('tooDark');
  });

  it('asks to slow down only when movement counts and is large', () => {
    expect(isMovingTooFast(null)).toBe(false);
    expect(isMovingTooFast(QUALITY.fastMotion)).toBe(false);
    expect(isMovingTooFast(QUALITY.fastMotion + 1)).toBe(true);
    expect(assessFrame({ brightness: 120, contrast: 40 }, QUALITY.fastMotion + 5)).toBe('slowDown');
    expect(assessFrame({ brightness: 120, contrast: 40 }, null)).toBeNull();
    expect(assessFrame({ brightness: 120, contrast: 40 }, 3)).toBeNull();
  });

  it('agrees with measure() on real pixels', () => {
    const covered = measure(frame(W, H, () => 4), W, H);
    expect(assessFrame(covered, null)).toBe('lensBlocked');
    const dim = measure(frame(W, H, (x, y) => ((x + y) % 2 === 0 ? 12 : 44)), W, H);
    expect(assessFrame(dim, null)).toBe('tooDark');
    const lit = measure(stripes(0), W, H);
    expect(assessFrame(lit, null)).toBeNull();
  });

  it('scores movement between frames, not a change of exposure', () => {
    const a = measure(stripes(0), W, H).signature;
    expect(motionScore(a, measure(stripes(1), W, H).signature)).toBeLessThan(QUALITY.fastMotion);
    expect(motionScore(a, measure(stripes(20), W, H).signature)).toBeGreaterThan(QUALITY.fastMotion);
    const brighter = measure(stripes(0, 70, 250), W, H).signature;
    expect(motionScore(a, brighter)).toBeLessThan(1);
    expect(motionScore([], [])).toBe(0);
  });

  it('shows a prompt after two checks in a row and holds it so it can be read', () => {
    const step = QUALITY.everyMs;
    let g: GuideState = GUIDE_IDLE;
    g = settleGuide(g, 'tooDark', 0);
    expect(g.shown).toBeNull();
    g = settleGuide(g, 'tooDark', step);
    expect(g.shown).toBe('tooDark');
    // Still dark: the prompt stays and its clock restarts.
    g = settleGuide(g, 'tooDark', 2 * step);
    // Light again: held for QUALITY.holdMs after the last dark check.
    g = settleGuide(g, null, 3 * step);
    expect(g.shown).toBe('tooDark');
    g = settleGuide(g, null, 2 * step + QUALITY.holdMs - 1);
    expect(g.shown).toBe('tooDark');
    g = settleGuide(g, null, 2 * step + QUALITY.holdMs);
    expect(g.shown).toBeNull();
  });

  it('ignores a one-off reading', () => {
    let g: GuideState = GUIDE_IDLE;
    g = settleGuide(g, 'slowDown', 0);
    g = settleGuide(g, null, 300);
    g = settleGuide(g, 'slowDown', 600);
    g = settleGuide(g, 'tooDark', 900);
    expect(g.shown).toBeNull();
  });

  it('lets a more serious prompt take over at once, and a lesser one only after the hold', () => {
    let g: GuideState = GUIDE_IDLE;
    g = settleGuide(g, 'slowDown', 0);
    g = settleGuide(g, 'slowDown', 300);
    expect(g.shown).toBe('slowDown');
    g = settleGuide(g, 'lensBlocked', 600);
    g = settleGuide(g, 'lensBlocked', 900);
    expect(g.shown).toBe('lensBlocked');
    g = settleGuide(g, 'slowDown', 1200);
    g = settleGuide(g, 'slowDown', 1500);
    expect(g.shown).toBe('lensBlocked');
    g = settleGuide(g, 'slowDown', 900 + QUALITY.holdMs);
    expect(g.shown).toBe('slowDown');
  });
});

describe('where boxes land on a cover-cropped viewfinder', () => {
  const landscape = { w: 1920, h: 1080 };
  const portraitPhone = { w: 390, h: 844 };

  it('is the identity when the shapes match', () => {
    const r = coverBox([0.1, 0.2, 0.3, 0.4], landscape, { w: 960, h: 540 });
    expect(r?.x).toBeCloseTo(0.1);
    expect(r?.y).toBeCloseTo(0.2);
    expect(r?.w).toBeCloseTo(0.3);
    expect(r?.h).toBeCloseTo(0.4);
  });

  it('stretches across a landscape frame cropped into a portrait screen', () => {
    // Only the middle 26% of the frame's width is on screen.
    const r = coverBox([0.45, 0.4, 0.1, 0.2], landscape, portraitPhone);
    const shown = (1920 * (844 / 1080)) / 390;
    expect(r?.x).toBeCloseTo((1 - shown) / 2 + 0.45 * shown);
    expect(r?.w).toBeCloseTo(0.1 * shown);
    expect(r?.y).toBeCloseTo(0.4);
    expect(r?.h).toBeCloseTo(0.2);
  });

  it('drops boxes in the cropped-off part and clips boxes at the edge', () => {
    expect(coverBox([0.02, 0.1, 0.1, 0.3], landscape, portraitPhone)).toBeNull();
    const edge = coverBox([0.3, 0.1, 0.2, 0.3], landscape, portraitPhone);
    expect(edge?.x).toBe(0);
    expect(edge?.w).toBeGreaterThan(0);
    expect(edge?.y).toBeCloseTo(0.1);
  });

  it('crops top and bottom when a portrait frame fills a landscape screen', () => {
    const r = coverBox([0.25, 0.5, 0.5, 0.25], { w: 1080, h: 1920 }, { w: 1280, h: 720 });
    const shown = (1920 * (1280 / 1080)) / 720;
    expect(r?.x).toBeCloseTo(0.25);
    expect(r?.w).toBeCloseTo(0.5);
    expect(r?.y).toBeCloseTo((1 - shown) / 2 + 0.5 * shown);
    expect(r?.h).toBeCloseTo(Math.min(1, (1 - shown) / 2 + 0.75 * shown) - r!.y);
  });

  it('refuses empty sizes', () => {
    expect(coverBox([0, 0, 1, 1], { w: 0, h: 0 }, portraitPhone)).toBeNull();
    expect(coverBox([0, 0, 1, 1], landscape, { w: 0, h: 10 })).toBeNull();
  });

  it('keeps the strongest boxes on screen, keyed by label from left to right', () => {
    const found = [det('Chair', 'stacking-chair', [0.6, 0.5, 0.1, 0.2], 0.7), det('Chair', 'stacking-chair', [0.4, 0.5, 0.1, 0.2], 0.8), det('Bed', 'bed', [0.01, 0.4, 0.05, 0.2], 0.95), det('Table', 'desk', [0.45, 0.6, 0.1, 0.1], 0.55)];
    const placed = layoutRegions(found, landscape, portraitPhone, 3);
    // The table is the weakest and is cut; the bed is off screen.
    expect(placed.map((p) => p.key)).toEqual(['Chair-0', 'Chair-1']);
    expect(placed[0]!.rect.x).toBeLessThan(placed[1]!.rect.x);
  });
});

describe('the tally of items spotted', () => {
  it('keeps the most seen of each kind in any one frame', () => {
    let t: Tally = new Map();
    t = mergeTally(t, [det('Chair', 'stacking-chair', [0, 0, 0.1, 0.1]), det('Chair', 'stacking-chair', [0.2, 0, 0.1, 0.1]), det('Bed', 'bed', [0.4, 0, 0.3, 0.3])]);
    t = mergeTally(t, [det('Chair', 'stacking-chair', [0, 0, 0.1, 0.1]), det('Chair', 'stacking-chair', [0.2, 0, 0.1, 0.1]), det('Chair', 'stacking-chair', [0.4, 0, 0.1, 0.1])]);
    t = mergeTally(t, [det('Chair', 'stacking-chair', [0, 0, 0.1, 0.1]), det('Clock', 'other', [0.5, 0, 0.1, 0.1]), det('Keyboard', 'other', [0.6, 0.5, 0.2, 0.1])]);
    expect(spottedList(t)).toEqual([
      { categoryId: 'stacking-chair', label: 'Chair', count: 3 },
      { categoryId: 'bed', label: 'Bed', count: 1 },
      { categoryId: 'other', label: 'Clock', count: 1 },
      { categoryId: 'other', label: 'Keyboard', count: 1 },
    ]);
  });

  it('returns the same tally when nothing grew', () => {
    const t = mergeTally(new Map(), [det('Sofa', 'sofa', [0, 0, 0.5, 0.5])]);
    expect(mergeTally(t, [det('Sofa', 'sofa', [0.1, 0, 0.5, 0.5])])).toBe(t);
    expect(mergeTally(t, [])).toBe(t);
  });
});

describe('recording type', () => {
  it('prefers MP4, then WebM with VP9, then VP8, then the default', () => {
    expect(pickMimeType((t) => t === 'video/mp4' || t.startsWith('video/webm'))).toBe('video/mp4');
    expect(pickMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9');
    expect(pickMimeType((t) => t === 'video/webm;codecs=vp8')).toBe('video/webm;codecs=vp8');
    expect(pickMimeType(() => false)).toBe('');
    expect(
      pickMimeType((t) => {
        if (t === 'video/mp4') throw new Error('not here');
        return true;
      }),
    ).toBe('video/webm;codecs=vp9');
  });
});
