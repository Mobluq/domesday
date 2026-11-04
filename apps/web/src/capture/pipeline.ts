import { useSyncExternalStore } from 'react';
import { buildPrompt, parseRecognition, proposalsToLines, PROMPT_VERSION, type PromptFrame, type Recognition } from '../ai/recognise';
import { newId } from '../data/actions';
import { nowIso } from '../data/derive';
import type { WalkBundle } from '../data/store';
import type { Box, Clip, Correction, Frame, Line, PersonId, RoomDef, RoomVisit, Site } from '../data/types';
import { blobFor, storeImage } from '../runtime/media';
import type { Runtime } from '../runtime/runtime';
import { isSampleError, type Json } from '../runtime/types';
import { fingerprint } from './fingerprint';
import { pickFrames, prepareStill } from './frames';
import { blurRegions } from './privacy';

/**
 * Processing a filmed room, on the device that filmed it: fingerprint, pick frames,
 * Claude proposes lines, blur, store. Jobs live outside React so a person can go back to
 * the room list while a room is still being processed.
 */

export type StepId = 'fingerprint' | 'frames' | 'recognise' | 'privacy' | 'store';
export type StepState = { readonly state: 'todo' | 'doing' | 'done' | 'skipped' | 'failed'; readonly detail?: string; readonly progress?: number };

export interface Job {
  readonly key: string;
  readonly roomId: string;
  readonly walkId: string;
  readonly phase: 'running' | 'done' | 'waiting' | 'failed';
  readonly steps: Readonly<Record<StepId, StepState>>;
  readonly sha256?: string;
  readonly clip?: Clip;
  readonly previews: readonly { readonly url: string; readonly t: number | null; readonly label?: boolean }[];
  readonly found: number;
  readonly linesProposed?: number;
  readonly message?: string;
  readonly startedAt: number;
}

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let snapshot: readonly Job[] = [];

function emit(): void {
  snapshot = [...jobs.values()];
  listeners.forEach((l) => l());
}

function patch(key: string, change: Partial<Job> | ((j: Job) => Partial<Job>)): void {
  const j = jobs.get(key);
  if (!j) return;
  jobs.set(key, { ...j, ...(typeof change === 'function' ? change(j) : change) });
  emit();
}

function step(key: string, id: StepId, s: StepState): void {
  patch(key, (j) => ({ steps: { ...j.steps, [id]: s } }));
}

export function useJobs(): readonly Job[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export function jobKey(walkId: string, roomId: string): string {
  return `${walkId}/${roomId}`;
}

export function stopJob(key: string): void {
  controllers.get(key)?.abort();
}

export function clearJob(key: string): void {
  jobs.delete(key);
  emit();
}

export interface Ctx {
  readonly rt: Runtime;
  readonly site: Site;
  readonly bundle: WalkBundle;
  readonly room: RoomDef;
  readonly personId: PersonId;
  readonly corrections?: readonly Correction[];
}

/** Turn this site's recent corrections into short lessons for the recogniser. */
export function lessonsFrom(site: Site, corrections: readonly Correction[] | undefined): string[] {
  const cat = (id: string): string => site.categories.find((c) => c.id === id)?.name ?? id;
  const room = (id: string): string => site.rooms.find((r) => r.id === id)?.name ?? id;
  const out: string[] = [];
  for (const c of corrections ?? []) {
    if (c.kind === 'relabel' && c.from && c.to) out.push(`"${c.from.description}" proposed as ${c.from.categoryId} was relabelled "${c.to.description}" (${c.to.categoryId}, ${cat(c.to.categoryId)}). Label items like it the same way.`);
    else if (c.kind === 'missed' && c.to) out.push(`The recogniser missed "${c.to.description}" (${c.to.categoryId}) in ${room(c.roomId)}. Look for items like it.`);
    else if (c.kind === 'rejected' && c.from) out.push(`"${c.from.description}" (${c.from.categoryId}) was rejected${c.reason ? `: ${c.reason}` : ''}. Do not propose items like it.`);
    if (out.length >= 12) break;
  }
  return out;
}

export interface CaptureInput {
  readonly file: Blob;
  readonly fileName: string;
  readonly source: Clip['source'];
  readonly labelShots: readonly Blob[];
  readonly recordedAt: string | null;
}

export const MODEL_LABEL = 'Claude, default tier';

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const m = /Android [\d.]+; ([^;)]+)/.exec(ua);
    return m?.[1]?.trim() ?? 'Android phone';
  }
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

export function canRecognise(rt: Runtime): boolean {
  return Boolean(rt.sample && rt.imageLimits);
}

function sampleMessage(e: unknown): { text: string; waiting: boolean } {
  const code = isSampleError(e) ? e.code : (e as Error)?.name === 'AbortError' ? 'cancelled' : 'upstream_error';
  switch (code) {
    case 'cancelled':
      return { text: 'Stopped. The frames are saved, so you can run recognition again.', waiting: true };
    case 'not_granted':
    case 'sampling_disabled':
    case 'capability_disabled':
    case 'images_unavailable':
      return { text: "Claude isn't allowed to look at frames on this device. The frames are saved; run recognition from a laptop.", waiting: true };
    case 'rate_limited':
      return { text: 'Claude is busy for this account right now. Wait a minute, then run recognition again.', waiting: true };
    case 'refused':
      return { text: 'Claude declined to describe these frames. Review the room by hand or film it again.', waiting: false };
    case 'invalid_json':
    case 'empty_completion':
      return { text: "Claude's answer couldn't be read. Run recognition again.", waiting: true };
    case 'image_rejected':
      return { text: 'One of the frames was rejected. Film the room again.', waiting: false };
    default:
      return { text: 'Recognition was interrupted. Run it again.', waiting: true };
  }
}

async function writeVisit(rt: Runtime, walkId: string, roomId: string, data: Partial<RoomVisit>): Promise<void> {
  const ref = rt.db.doc(`walks/${walkId}/rooms/${roomId}`);
  const snap = await ref.get();
  if (snap.exists) await ref.update(data as unknown as Json);
  else await ref.set({ roomId, status: 'not_started', skipReason: null, filmedBy: null, filmedAt: null, clip: null, frames: [], labelShots: [], analysis: { status: 'idle' }, updatedAt: nowIso(), ...data } as unknown as Json);
}

async function markWalk(ctx: Ctx): Promise<void> {
  const w = ctx.bundle.walk;
  const capturedBy = w.capturedBy.includes(ctx.personId) ? w.capturedBy : [...w.capturedBy, ctx.personId];
  await ctx.rt.db.doc(`walks/${w.id}`).update({ startedAt: w.startedAt ?? nowIso(), capturedBy, status: w.status === 'approved' ? 'approved' : 'capturing' } as unknown as Json);
}

/** Remove the room's undecided lines from an earlier clip before new proposals arrive. */
async function clearOpenLines(ctx: Ctx): Promise<number> {
  let kept = 0;
  for (const l of ctx.bundle.lines) {
    if (l.roomId !== ctx.room.id) continue;
    if (l.status === 'proposed') await ctx.rt.db.doc(`walks/${ctx.bundle.walk.id}/lines/${l.id}`).delete();
    else kept += 1;
  }
  return kept;
}

async function recognise(rt: Runtime, site: Site, room: RoomDef, frames: readonly PromptFrame[], blobs: readonly Blob[], signal: AbortSignal, onFound: (n: number) => void, learned: readonly string[] = []): Promise<Recognition> {
  if (!rt.sample) throw { code: 'images_unavailable', message: 'no sample' };
  const prompt = buildPrompt({ siteName: site.name, room, frames, categories: site.categories, learned });
  const raw = await rt.sample.json(prompt, {
    images: [...blobs],
    signal,
    modelTier: 'default',
    onText: ({ text }) => onFound((text.match(/"category"\s*:/g) ?? []).length),
  });
  return parseRecognition(raw, frames, site.categories);
}

function initialSteps(): Record<StepId, StepState> {
  return { fingerprint: { state: 'todo' }, frames: { state: 'todo' }, recognise: { state: 'todo' }, privacy: { state: 'todo' }, store: { state: 'todo' } };
}

/** Film a room: the whole pipeline for one clip, on this device. */
export async function processRoom(ctx: Ctx, input: CaptureInput): Promise<void> {
  const { rt, site, room, bundle, personId } = ctx;
  const key = jobKey(bundle.walk.id, room.id);
  if (jobs.get(key)?.phase === 'running') return;
  const ctl = new AbortController();
  controllers.set(key, ctl);
  jobs.set(key, { key, roomId: room.id, walkId: bundle.walk.id, phase: 'running', steps: initialSteps(), previews: [], found: 0, startedAt: Date.now() });
  emit();
  const startedAt = nowIso();
  let stage: StepId = 'fingerprint';
  try {
    step(key, 'fingerprint', { state: 'doing', progress: 0 });
    const sha256 = await fingerprint(input.file, (p) => step(key, 'fingerprint', { state: 'doing', progress: p }), ctl.signal);
    step(key, 'fingerprint', { state: 'done', detail: `${sha256.slice(0, 8)}…${sha256.slice(-6)}` });
    patch(key, { sha256 });

    stage = 'frames';
    step(key, 'frames', { state: 'doing', progress: 0 });
    const limit = rt.imageLimits?.maxCount ?? 8;
    const maxFrames = Math.max(2, Math.min(8, limit - input.labelShots.length));
    const picked = await pickFrames(input.file, { maxFrames, signal: ctl.signal, onProgress: (p) => step(key, 'frames', { state: 'doing', progress: p }) });
    const stills = await Promise.all(input.labelShots.slice(0, Math.max(0, limit - picked.frames.length)).map((b) => prepareStill(b)));
    patch(key, { previews: [...picked.frames.map((f) => ({ url: f.url, t: f.t })), ...stills.map((s) => ({ url: s.url, t: null, label: true }))] });
    step(key, 'frames', { state: 'done', detail: `${picked.frames.length} frames${stills.length ? `, ${stills.length} label shot${stills.length > 1 ? 's' : ''}` : ''}` });

    const clip: Clip = {
      source: input.source,
      fileName: input.fileName,
      type: input.file.type || 'video/mp4',
      sizeBytes: input.file.size,
      durationS: Math.round(picked.info.durationS * 10) / 10,
      width: picked.info.width,
      height: picked.info.height,
      sha256,
      fingerprintedAt: nowIso(),
      recordedAt: input.recordedAt,
      device: deviceLabel(),
      checks: picked.checks,
    };
    patch(key, { clip });
    const able = canRecognise(rt);
    await writeVisit(rt, bundle.walk.id, room.id, {
      status: 'filmed',
      skipReason: null,
      filmedBy: personId,
      filmedAt: startedAt,
      clip,
      frames: [],
      labelShots: [],
      analysis: { status: able ? 'running' : 'waiting', startedAt, by: personId, model: able ? MODEL_LABEL : null, prompt: PROMPT_VERSION },
      updatedAt: nowIso(),
      refilmRequested: null,
    });
    await markWalk(ctx);

    const tag = sha256.slice(0, 6);
    const promptFrames: PromptFrame[] = [
      ...picked.frames.map((f, i) => ({ ref: `F${i + 1}`, frameId: `${room.id}-${tag}-f${i + 1}`, t: f.t, label: false })),
      ...stills.map((_, i) => ({ ref: `L${i + 1}`, frameId: `${room.id}-${tag}-l${i + 1}`, t: null, label: true })),
    ];
    const blobs = [...picked.frames.map((f) => f.blob), ...stills.map((s) => s.blob)];
    const dims = [...picked.frames.map((f) => ({ w: f.w, h: f.h, sharpness: f.sharpness })), ...stills.map((s) => ({ w: s.w, h: s.h, sharpness: undefined }))];

    let recognition: Recognition | null = null;
    let failure: { text: string; waiting: boolean } | null = null;
    stage = 'recognise';
    if (able) {
      step(key, 'recognise', { state: 'doing', detail: `Claude is looking at ${blobs.length} images` });
      try {
        recognition = await recognise(rt, site, room, promptFrames, blobs, ctl.signal, (n) => patch(key, { found: n }), lessonsFrom(site, ctx.corrections));
        step(key, 'recognise', { state: 'done', detail: `${recognition.proposals.length} ${recognition.proposals.length === 1 ? 'line' : 'lines'} proposed` });
      } catch (e) {
        failure = sampleMessage(e);
        step(key, 'recognise', { state: 'failed', detail: failure.text });
      }
    } else {
      step(key, 'recognise', { state: 'skipped', detail: 'Claude cannot look at images on this device. A laptop will run this step.' });
    }

    stage = 'privacy';
    let blurredCount = 0;
    const toStore: Blob[] = [];
    if (recognition) {
      step(key, 'privacy', { state: 'doing' });
      for (let i = 0; i < blobs.length; i += 1) {
        const regions = recognition.privacy.get(promptFrames[i]?.frameId ?? '') ?? [];
        blurredCount += regions.length;
        toStore.push(await blurRegions(blobs[i] as Blob, regions.map((r) => r.box as Box)));
      }
      step(key, 'privacy', { state: 'done', detail: blurredCount ? `${blurredCount} region${blurredCount > 1 ? 's' : ''} blurred` : 'No faces, screens or documents found' });
    } else {
      toStore.push(...blobs);
      step(key, 'privacy', { state: 'skipped', detail: 'Runs with recognition. Frames stay hidden from reviewers until then.' });
    }

    stage = 'store';
    step(key, 'store', { state: 'doing', progress: 0 });
    const frames: Frame[] = [];
    const labels: Frame[] = [];
    for (let i = 0; i < toStore.length; i += 1) {
      const ref = await storeImage(rt, toStore[i] as Blob);
      const pf = promptFrames[i] as PromptFrame;
      const d = dims[i] as { w: number; h: number; sharpness?: number };
      const blurred = recognition ? (recognition.privacy.get(pf.frameId)?.length ?? 0) : undefined;
      const f: Frame = { id: pf.frameId, ref, t: pf.t, w: d.w, h: d.h, ...(d.sharpness !== undefined ? { sharpness: d.sharpness } : {}), ...(pf.label ? { label: true } : {}), ...(blurred !== undefined ? { blurred } : {}) };
      (pf.label ? labels : frames).push(f);
      step(key, 'store', { state: 'doing', progress: (i + 1) / toStore.length });
    }

    const kept = await clearOpenLines(ctx);
    let linesProposed = 0;
    if (recognition) {
      const at = nowIso();
      const lines: Line[] = proposalsToLines(recognition, { walkId: bundle.walk.id, roomId: room.id, model: MODEL_LABEL, at, idFor: () => newId(`l-${room.id}`) });
      for (const l of lines) await rt.db.doc(`walks/${bundle.walk.id}/lines/${l.id}`).set(l as unknown as Json);
      linesProposed = lines.length;
    }
    const privacy = recognition ? countPrivacy(recognition) : null;
    await writeVisit(rt, bundle.walk.id, room.id, {
      frames,
      labelShots: labels,
      analysis: {
        status: recognition ? 'done' : failure && !failure.waiting ? 'failed' : 'waiting',
        startedAt,
        finishedAt: nowIso(),
        by: personId,
        model: recognition ? MODEL_LABEL : null,
        prompt: PROMPT_VERSION,
        linesProposed,
        error: failure?.text ?? null,
        note: [recognition?.roomNote, kept ? `Filmed again. ${kept} decided line${kept > 1 ? 's' : ''} from the earlier clip kept.` : null].filter(Boolean).join(' ') || null,
        privacy,
      },
      updatedAt: nowIso(),
    });
    step(key, 'store', { state: 'done', detail: `${frames.length + labels.length} images stored` });
    patch(key, { phase: recognition ? 'done' : 'waiting', linesProposed, message: failure?.text });
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    const text = aborted ? 'Stopped before anything was saved.' : String((e as Error)?.message ?? e);
    step(key, stage, { state: 'failed', detail: text });
    patch(key, { phase: 'failed', message: text });
  } finally {
    controllers.delete(key);
  }
}

function countPrivacy(r: Recognition): { faces: number; screens: number; documents: number } {
  let faces = 0;
  let screens = 0;
  let documents = 0;
  for (const list of r.privacy.values()) {
    for (const p of list) {
      if (p.kind.includes('screen')) screens += 1;
      else if (p.kind.includes('doc')) documents += 1;
      else faces += 1;
    }
  }
  return { faces, screens, documents };
}

/**
 * Run recognition for a room whose frames were stored by a device that couldn't (or was
 * stopped). Blurs and replaces the stored frames, then proposes lines.
 */
export async function recogniseStoredRoom(ctx: Ctx): Promise<void> {
  const { rt, site, room, bundle, personId } = ctx;
  const visit = bundle.rooms.get(room.id);
  const key = jobKey(bundle.walk.id, room.id);
  if (!visit || jobs.get(key)?.phase === 'running') return;
  const ctl = new AbortController();
  controllers.set(key, ctl);
  const steps = initialSteps();
  steps.fingerprint = { state: 'done', detail: visit.clip ? `${visit.clip.sha256.slice(0, 8)}…` : 'Taken on the phone' };
  steps.frames = { state: 'done', detail: `${visit.frames.length} frames` };
  jobs.set(key, { key, roomId: room.id, walkId: bundle.walk.id, phase: 'running', steps, previews: [], found: 0, startedAt: Date.now() });
  emit();
  const startedAt = nowIso();
  try {
    const all = [...visit.frames, ...visit.labelShots];
    const blobs: Blob[] = [];
    for (const f of all) {
      const b = await blobFor(f.ref);
      if (!b) throw new Error('A stored frame could not be read back.');
      blobs.push(b);
    }
    const promptFrames: PromptFrame[] = all.map((f) => ({ ref: '', frameId: f.id, t: f.t, label: Boolean(f.label) }));
    let fi = 0;
    let li = 0;
    const refs = promptFrames.map((f) => ({ ...f, ref: f.label ? `L${++li}` : `F${++fi}` }));
    await writeVisit(rt, bundle.walk.id, room.id, { analysis: { ...visit.analysis, status: 'running', startedAt, by: personId, model: MODEL_LABEL, prompt: PROMPT_VERSION, error: null } });
    step(key, 'recognise', { state: 'doing', detail: `Claude is looking at ${blobs.length} images` });
    const recognition = await recognise(rt, site, room, refs, blobs, ctl.signal, (n) => patch(key, { found: n }), lessonsFrom(site, ctx.corrections));
    step(key, 'recognise', { state: 'done', detail: `${recognition.proposals.length} ${recognition.proposals.length === 1 ? 'line' : 'lines'} proposed` });

    step(key, 'privacy', { state: 'doing' });
    const replaced: Frame[] = [];
    const old: string[] = [];
    for (let i = 0; i < all.length; i += 1) {
      const f = all[i] as Frame;
      const regions = recognition.privacy.get(f.id) ?? [];
      if (f.blurred === undefined) {
        const blob = await blurRegions(blobs[i] as Blob, regions.map((r) => r.box as Box));
        const ref = await storeImage(rt, blob);
        if (f.ref.kind === 'asset') old.push(f.ref.id);
        replaced.push({ ...f, ref, blurred: regions.length });
      } else {
        replaced.push(f);
      }
    }
    step(key, 'privacy', { state: 'done' });
    step(key, 'store', { state: 'doing' });
    await clearOpenLines(ctx);
    const at = nowIso();
    const lines = proposalsToLines(recognition, { walkId: bundle.walk.id, roomId: room.id, model: MODEL_LABEL, at, idFor: () => newId(`l-${room.id}`) });
    for (const l of lines) await rt.db.doc(`walks/${bundle.walk.id}/lines/${l.id}`).set(l as unknown as Json);
    await writeVisit(rt, bundle.walk.id, room.id, {
      frames: replaced.filter((f) => !f.label),
      labelShots: replaced.filter((f) => f.label),
      analysis: { status: 'done', startedAt, finishedAt: nowIso(), by: personId, model: MODEL_LABEL, prompt: PROMPT_VERSION, linesProposed: lines.length, error: null, note: recognition.roomNote, privacy: countPrivacy(recognition) },
      updatedAt: nowIso(),
    });
    // The unblurred copies are no longer pointed at by any document.
    for (const id of old) await rt.assets?.delete(id).catch(() => undefined);
    step(key, 'store', { state: 'done' });
    patch(key, { phase: 'done', linesProposed: lines.length });
  } catch (e) {
    const m = sampleMessage(e);
    step(key, 'recognise', { state: 'failed', detail: m.text });
    patch(key, { phase: 'failed', message: m.text });
    await writeVisit(rt, bundle.walk.id, room.id, { analysis: { ...visit.analysis, status: m.waiting ? 'waiting' : 'failed', error: m.text } }).catch(() => undefined);
  } finally {
    controllers.delete(key);
  }
}
