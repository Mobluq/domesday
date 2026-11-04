import { useSyncExternalStore } from 'react';
import { newId } from '../data/actions';
import { approvedLines, categoryName, nowIso } from '../data/derive';
import type { AppData } from '../data/store';
import type { Box, CameraCheck, CameraDef, PersonId, Sighting, Site } from '../data/types';
import { storeImage } from '../runtime/media';
import { isSampleError, type Json } from '../runtime/types';
import { fingerprint } from './fingerprint';
import { pickFrames, prepareStill } from './frames';
import { blurRegions } from './privacy';

/**
 * Camera checks: one still from a CCTV camera, checked against what its room should
 * hold. Spaces, not people: faces are blurred before the still is stored, there is no
 * live view, and an item that cannot be seen is "not visible from this camera", never
 * missing. In production the on-site gateway sends the still; in the demo it comes from
 * a recorder export or the camera's sample still.
 */

export const CAMERA_PROMPT_VERSION = 'dms-camera-1';

export interface Expected {
  readonly ref: string;
  readonly lineId: string | null;
  readonly registerId: string | null;
  readonly categoryId: string;
  readonly description: string;
}

/** What the room should hold: the latest approved lines there, plus register lines no walk has covered. */
export function expectedFor(data: AppData, roomId: string): Expected[] {
  const { site, register, current, previous } = data;
  if (!site) return [];
  const out: Expected[] = [];
  const seenRegister = new Set<string>();
  const source = current && current.walk.status === 'approved' ? current : previous;
  for (const l of approvedLines(source).filter((x) => x.roomId === roomId)) {
    if (l.registerId) seenRegister.add(l.registerId);
    out.push({ ref: '', lineId: l.id, registerId: l.registerId ?? null, categoryId: l.categoryId, description: `${l.kind === 'counted_group' ? `${l.quantity} × ` : ''}${l.description}` });
  }
  for (const r of register?.lines ?? []) {
    if (r.roomId !== roomId || seenRegister.has(r.registerId)) continue;
    out.push({ ref: '', lineId: null, registerId: r.registerId, categoryId: r.categoryId ?? 'other', description: `${r.description} (register ${r.registerId})` });
  }
  return out.slice(0, 30).map((e, i) => ({ ...e, ref: `E${i + 1}` }));
}

export function buildCameraPrompt(site: Site, camera: CameraDef, roomName: string, expected: readonly Expected[]): string {
  const list = expected.length ? expected.map((e) => `${e.ref}: ${e.description} [${categoryName(site, e.categoryId)}]`).join('\n') : '(nothing recorded for this room yet)';
  const cats = site.categories.map((c) => `${c.id}: ${c.name}`).join('\n');
  return `You are checking a still from a fixed CCTV camera for Domesday, a fixed asset register. The image is one frame from ${camera.name}, which looks at ${roomName} at ${site.name}. It is a wide, often grainy view from high up.

These assets are recorded for this room:
${list}

For each recorded asset, say whether it is visible in this image: "visible" only when you can actually see it; otherwise "not_visible" (it may be out of shot, hidden or gone; you cannot tell which, so never say missing). For a counted group, say how many you can see in "note".
Then list any other fixed assets you can clearly see that are not on the list, using a category id from the list below.
Ignore people, belongings, consumables and building fabric. Never describe a person. List every visible face, and any screen or document with readable content, so they can be blurred.

Boxes are [x, y, width, height] as fractions of the image, from the top-left.

Categories (id: name):
${cats}

Reply with only JSON in exactly this shape:
{"expected":[{"ref":"E1","status":"visible","box":[0.1,0.2,0.3,0.4],"note":"seen side-on"}],"other":[{"category":"desk","description":"Wooden desk under the window","box":[0.5,0.5,0.3,0.3]}],"privacy":[{"box":[0.4,0.1,0.05,0.08],"kind":"face"}],"note":"One short sentence on what the camera can and cannot see."}`;
}

function toBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map(Number);
  if (n.some((x) => !Number.isFinite(x))) return null;
  let [x, y, w, h] = n as [number, number, number, number];
  if ([x, y, w, h].some((q) => q > 1.5)) [x, y, w, h] = [x / 100, y / 100, w / 100, h / 100];
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  w = Math.min(1 - x, Math.max(0, w));
  h = Math.min(1 - y, Math.max(0, h));
  return w > 0.005 && h > 0.005 ? [x, y, w, h] : null;
}

const s = (v: unknown, max = 140): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function parseCameraAnswer(raw: unknown, expected: readonly Expected[], site: Site): { sightings: Sighting[]; privacy: Box[]; note: string | null } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const byRef = new Map(expected.map((e) => [e.ref, e]));
  const answered = new Map<string, Record<string, unknown>>();
  for (const e of Array.isArray(o.expected) ? o.expected : []) {
    const eo = (e ?? {}) as Record<string, unknown>;
    const ref = s(eo.ref, 6).toUpperCase();
    if (byRef.has(ref) && !answered.has(ref)) answered.set(ref, eo);
  }
  const sightings: Sighting[] = expected.map((e) => {
    const a = answered.get(e.ref);
    const visible = s(a?.status, 20).toLowerCase() === 'visible';
    return { lineId: e.lineId, registerId: e.registerId, categoryId: e.categoryId, description: e.description, status: visible ? 'visible' : 'not_visible', box: visible ? toBox(a?.box) : null, note: s(a?.note) || null };
  });
  const cats = new Set(site.categories.map((c) => c.id));
  for (const x of (Array.isArray(o.other) ? o.other : []).slice(0, 20)) {
    const xo = (x ?? {}) as Record<string, unknown>;
    const cat = s(xo.category, 40).toLowerCase();
    sightings.push({ lineId: null, registerId: null, categoryId: cats.has(cat) ? cat : 'other', description: s(xo.description) || 'Asset', status: 'new', box: toBox(xo.box), note: null });
  }
  const privacy = (Array.isArray(o.privacy) ? o.privacy : []).map((p) => toBox(((p ?? {}) as Record<string, unknown>).box)).filter((b): b is Box => b !== null);
  return { sightings, privacy, note: s(o.note, 240) || null };
}

// A tiny store of running checks, so the page can show progress.
type Running = { readonly cameraId: string; readonly stage: string; readonly error?: string };
let running: Running[] = [];
const subs = new Set<() => void>();
const set = (next: Running[]): void => {
  running = next;
  subs.forEach((l) => l());
};
export function useRunningChecks(): readonly Running[] {
  return useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    () => running,
  );
}

export async function runCameraCheck(data: AppData, camera: CameraDef, input: { file: Blob; source: CameraCheck['source']; capturedAt: string }, by: PersonId): Promise<{ ok: boolean; message: string }> {
  const { rt, site } = data;
  if (!site) return { ok: false, message: 'No site.' };
  const stage = (st: string): void => set([...running.filter((r) => r.cameraId !== camera.id), { cameraId: camera.id, stage: st }]);
  const done = (): void => set(running.filter((r) => r.cameraId !== camera.id));
  const id = newId('check');
  const roomName = site.rooms.find((r) => r.id === camera.roomId)?.name ?? camera.roomId;
  try {
    stage('Fingerprinting the still');
    const sha256 = await fingerprint(input.file);
    stage('Reading the image');
    let still: { blob: Blob; w: number; h: number };
    if (input.file.type.startsWith('video/')) {
      const picked = await pickFrames(input.file, { maxFrames: 1 });
      const f = picked.frames[0];
      if (!f) throw new Error('No usable frame in that recording.');
      still = { blob: f.blob, w: f.w, h: f.h };
    } else {
      still = await prepareStill(input.file);
    }
    if (!rt.sample || !rt.imageLimits) {
      return { ok: false, message: "Claude can't look at images on this device, so the check can't run here. Try it from a laptop." };
    }
    const expected = expectedFor(data, camera.roomId);
    stage(`Claude is checking ${expected.length ? `${expected.length} recorded items` : 'the room'}`);
    const raw = await rt.sample.json(buildCameraPrompt(site, camera, roomName, expected), { images: [still.blob], modelTier: 'default' });
    const parsed = parseCameraAnswer(raw, expected, site);
    stage('Blurring faces and screens');
    const blurred = await blurRegions(still.blob, parsed.privacy);
    stage('Saving');
    const ref = await storeImage(rt, blurred);
    const check: CameraCheck = {
      id,
      cameraId: camera.id,
      roomId: camera.roomId,
      capturedAt: input.capturedAt,
      source: input.source,
      still: { id: `${id}-still`, ref, t: null, w: still.w, h: still.h, blurred: parsed.privacy.length },
      sha256,
      status: 'done',
      error: null,
      sightings: parsed.sightings,
      blurred: parsed.privacy.length,
      by,
      createdAt: nowIso(),
      note: parsed.note,
    };
    await rt.db.doc(`camera-checks/${id}`).set(check as unknown as Json);
    const visible = parsed.sightings.filter((x) => x.status === 'visible').length;
    return { ok: true, message: `${camera.name}: ${visible} of ${expected.length} recorded items visible` };
  } catch (e) {
    const code = isSampleError(e) ? e.code : '';
    const message =
      code === 'not_granted' || code === 'images_unavailable'
        ? "Claude isn't allowed to look at images in this view."
        : code === 'rate_limited'
          ? 'Claude is busy for this account. Try again in a minute.'
          : `The check didn't finish: ${isSampleError(e) ? e.message : String((e as Error)?.message ?? e)}`;
    return { ok: false, message };
  } finally {
    done();
  }
}
