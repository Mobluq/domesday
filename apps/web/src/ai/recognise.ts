import { ConditionGrade, ConfidenceBand, checkReadProvenance, type ConditionGrade as Grade, type ConfidenceBand as Band } from '@domesday/domain';
import type { Box, Category, Evidence, Line, Reading, RoomDef } from '../data/types';

/**
 * Pipeline stages 4 to 7 for the demo: Claude looks at the picked frames and label shots
 * through the artifact's `sample` capability and proposes asset lines in a fixed JSON
 * shape, with the tenant's categories as the only allowed values. The page then checks
 * every value (stage 7, assemble and score) before anything reaches a reviewer.
 */

export const PROMPT_VERSION = 'dms-recognise-2';

export interface PromptFrame {
  /** "F1", "L1": how Claude refers to the image. */
  readonly ref: string;
  readonly frameId: string;
  readonly t: number | null;
  readonly label: boolean;
}

export interface PromptInput {
  readonly siteName: string;
  readonly room: RoomDef;
  readonly frames: readonly PromptFrame[];
  readonly categories: readonly Category[];
  /** Lessons from this site's reviewers, newest first (DMS-055: used for this site only). */
  readonly learned?: readonly string[];
}

const tc = (t: number | null): string => {
  if (t === null) return 'label shot';
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

export function buildPrompt(input: PromptInput): string {
  const frameList = input.frames.map((f) => `${f.ref}: ${f.label ? 'label shot, a close-up still taken to read a plate or tag' : `video frame at ${tc(f.t)}`}`).join('\n');
  const cats = input.categories.map((c) => `${c.id}: ${c.name}`).join('\n');
  return `You are the recogniser in Domesday, a fixed asset register built by filming rooms on a phone. A named person will review every line you propose, so be accurate rather than complete, and say when you are unsure.

The images attached are, in this order:
${frameList}

They come from one room: ${input.room.name} (${input.room.floor}${input.room.note ? `, ${input.room.note.toLowerCase()}` : ''}) at ${input.siteName}.

Propose asset lines by these rules:
1. One line per physical item. An item seen in several images is still one line; list every image it appears in.
2. Identical untagged items in this room (chairs, desks, lamps of the same model) become ONE counted group with a quantity. Count across the images without counting the same item twice. If you can only see part of a group, count what you can see and say so in confidence_reason.
3. category must be exactly one id from the list below. Use "other" only when nothing fits, and then make the description say what it is.
4. make, model, serial and tag: only when the text is clearly legible in an image. Give the exact characters you read, the image ref, and a box around the text. Never guess, complete or infer a number or a brand from the shape of an item. An asset tag looks like a printed label with a code such as "FA-0412".
5. condition is one of good, fair, poor, not_working_or_unsafe, judged only from what is visible, with the visible reason in a few plain words (for example "water marks below the unit", "pressure gauge needle in the red zone", "no visible wear").
6. confidence is high (clearly visible and unambiguous), medium, or low (partly visible, unsure what it is, or the count is uncertain).
7. safety: if an item looks unsafe (a fire extinguisher not in the green, exposed wiring, a blocked exit), say why in a few words; otherwise null.
8. Ignore: people, clothing and personal belongings, consumables (paper, food, drinks, plants), and building fabric and fixtures (walls, windows, doors, curtains, blinds, light switches, sockets, wall brackets, ceiling lights, floors, built-in cupboards).
9. Never describe or grade a person. Never call anything missing, lost or stolen.
10. privacy: list every visible face, every screen showing content, and every document with readable personal text, with the image ref and a box, so they can be blurred before anyone reviews the frames.

Boxes are [x, y, width, height] as fractions of that image's width and height, from the top-left corner, tight around the thing.
${input.learned?.length ? `\nReviewers at this site have corrected earlier answers. Follow these lessons:\n${input.learned.map((l) => `- ${l}`).join('\n')}\n` : ''}
Categories (id: name):
${cats}

Reply with only JSON in exactly this shape:
{"lines":[{"category":"split-ac","description":"Wall-mounted split air conditioner, indoor unit","kind":"single_item","quantity":1,"condition":"poor","condition_reason":"water marks on the wall below the unit","confidence":"high","confidence_reason":"clearly visible in two images","safety":null,"seen_in":[{"image":"F1","box":[0.05,0.08,0.9,0.4]}],"reads":[{"field":"make","value":"LG","image":"F2","box":[0.16,0.24,0.14,0.16]}]}],"privacy":[{"image":"F3","box":[0.4,0.1,0.1,0.15],"kind":"face"}],"room_note":"One short sentence on what the footage covers or misses."}

kind is "single_item" or "counted_group". field is one of "make", "model", "serial", "tag". If you see no assets, reply {"lines":[],"privacy":[],"room_note":"..."}.`;
}

export interface Proposal {
  readonly categoryId: string;
  readonly description: string;
  readonly kind: 'single_item' | 'counted_group';
  readonly quantity: number;
  readonly condition: Grade;
  readonly conditionReason: string;
  readonly band: Band;
  readonly bandReason: string | null;
  readonly safety: string | null;
  readonly evidence: readonly Evidence[];
  readonly make: Reading | null;
  readonly model: Reading | null;
  readonly serial: Reading | null;
  readonly tagCode: Reading | null;
  readonly notes: readonly string[];
}

export interface Recognition {
  readonly proposals: readonly Proposal[];
  /** Regions to blur, by frame id. */
  readonly privacy: ReadonlyMap<string, { box: Box; kind: string }[]>;
  readonly roomNote: string | null;
}

function str(v: unknown, max = 160): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function toBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map((x) => (typeof x === 'number' ? x : Number(x)));
  if (n.some((x) => !Number.isFinite(x))) return null;
  let [x, y, w, h] = n as [number, number, number, number];
  // Some answers give pixel-like percentages; accept 0-100 as well as 0-1.
  if ([x, y, w, h].some((q) => q > 1.5)) [x, y, w, h] = [x / 100, y / 100, w / 100, h / 100];
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  w = Math.min(1 - x, Math.max(0, w));
  h = Math.min(1 - y, Math.max(0, h));
  if (w < 0.005 || h < 0.005) return null;
  const r = (q: number): number => Math.round(q * 1000) / 1000;
  return [r(x), r(y), r(w), r(h)];
}

const LOWER: Record<Band, Band> = { high: 'medium', medium: 'low', low: 'low' };
const FIELD: Record<string, 'make' | 'model' | 'serial' | 'tagCode'> = { make: 'make', brand: 'make', model: 'model', serial: 'serial', 'serial number': 'serial', tag: 'tagCode', asset_tag: 'tagCode', 'asset tag': 'tagCode' };

/** Check and shape Claude's answer. Anything outside the rules is corrected or dropped, and said so. */
export function parseRecognition(raw: unknown, frames: readonly PromptFrame[], categories: readonly Category[]): Recognition {
  const byRef = new Map(frames.map((f) => [f.ref.toUpperCase(), f]));
  const catIds = new Set(categories.map((c) => c.id));
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const lines = Array.isArray(obj.lines) ? obj.lines : [];
  const proposals: Proposal[] = [];

  for (const item of lines.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const notes: string[] = [];
    let categoryId = str(o.category, 40).toLowerCase();
    let description = str(o.description, 140);
    if (!catIds.has(categoryId)) {
      if (categoryId) notes.push(`Category "${categoryId}" is not on the list, so it was set to Other asset.`);
      categoryId = 'other';
    }
    const qRaw = Math.round(Number(o.quantity));
    const quantity = Number.isFinite(qRaw) && qRaw >= 1 ? Math.min(qRaw, 999) : 1;
    const kind = quantity > 1 ? 'counted_group' : 'single_item';
    const condRaw = str(o.condition, 40).toLowerCase().replace(/[\s-]+/g, '_');
    const condition: Grade = (ConditionGrade.values as readonly string[]).includes(condRaw)
      ? (condRaw as Grade)
      : condRaw.includes('unsafe') || condRaw.includes('not_working')
        ? 'not_working_or_unsafe'
        : 'fair';
    const conditionReason = str(o.condition_reason, 120) || 'No reason given';
    const bandRaw = str(o.confidence, 10).toLowerCase();
    let band: Band = (ConfidenceBand.values as readonly string[]).includes(bandRaw) ? (bandRaw as Band) : 'low';
    const safety = str(o.safety, 140) || null;

    const evidence: Evidence[] = [];
    const seen = Array.isArray(o.seen_in) ? o.seen_in : [];
    for (const s of seen) {
      const so = (s ?? {}) as Record<string, unknown>;
      const f = byRef.get(str(so.image, 8).toUpperCase());
      if (!f || evidence.some((e) => e.frameId === f.frameId)) continue;
      evidence.push({ frameId: f.frameId, box: toBox(so.box) });
    }
    if (evidence.length === 0 && frames[0]) {
      evidence.push({ frameId: frames[0].frameId, box: null });
      notes.push('No image was named for this line, so it points at the first frame.');
    }

    const reads: Partial<Record<'make' | 'model' | 'serial' | 'tagCode', Reading>> = {};
    for (const r of Array.isArray(o.reads) ? o.reads : []) {
      const ro = (r ?? {}) as Record<string, unknown>;
      const field = FIELD[str(ro.field, 20).toLowerCase()];
      const value = str(ro.value, 60);
      if (!field || !value) continue;
      const f = byRef.get(str(ro.image, 8).toUpperCase());
      const box = toBox(ro.box);
      // "Never guess a number" (DMS-033): a value with no source region is rejected.
      const check = checkReadProvenance({ serial: { value, sourceRegion: f && box ? { frameId: f.frameId, x: box[0], y: box[1], width: box[2], height: box[3] } : null } });
      if (!check.ok || !f || !box) {
        notes.push(`A ${field === 'tagCode' ? 'tag' : field} of "${value}" came with no readable source, so it was left out.`);
        continue;
      }
      if (!reads[field]) reads[field] = { value, source: 'read', frameId: f.frameId, box };
    }

    // Stage 7, assemble and score: confidence never goes up, only down.
    const why: string[] = [];
    const bandReason = str(o.confidence_reason, 140);
    if (bandReason) why.push(bandReason);
    if (categoryId === 'other' && band === 'high') {
      band = 'medium';
      why.push('Category is Other asset');
    }
    if (kind === 'counted_group' && quantity >= 10 && band === 'high') {
      band = 'medium';
      why.push(`A count of ${quantity} from video needs checking`);
    }
    if (safety && band === 'high') band = LOWER[band];
    if (!description) description = categories.find((c) => c.id === categoryId)?.name ?? 'Asset';

    proposals.push({
      categoryId,
      description,
      kind,
      quantity,
      condition,
      conditionReason,
      band,
      bandReason: why.join('. ') || null,
      safety,
      evidence,
      make: reads.make ?? null,
      model: reads.model ?? null,
      serial: reads.serial ?? null,
      tagCode: reads.tagCode ?? null,
      notes,
    });
  }

  const privacy = new Map<string, { box: Box; kind: string }[]>();
  for (const p of Array.isArray(obj.privacy) ? obj.privacy : []) {
    const po = (p ?? {}) as Record<string, unknown>;
    const f = byRef.get(str(po.image, 8).toUpperCase());
    const box = toBox(po.box);
    if (!f || !box) continue;
    const list = privacy.get(f.frameId) ?? [];
    list.push({ box, kind: str(po.kind, 20) || 'face' });
    privacy.set(f.frameId, list);
  }
  return { proposals, privacy, roomNote: str(obj.room_note, 240) || null };
}

/** Turn proposals into line documents for the walk. */
export function proposalsToLines(
  recognition: Recognition,
  ctx: { walkId: string; roomId: string; model: string; at: string; idFor: (i: number) => string },
): Line[] {
  const base = Date.parse(ctx.at);
  return recognition.proposals.map((p, i) => ({
    id: ctx.idFor(i),
    walkId: ctx.walkId,
    roomId: ctx.roomId,
    createdAt: new Date(base + i).toISOString(),
    kind: p.kind,
    quantity: p.quantity,
    categoryId: p.categoryId,
    description: p.description,
    make: p.make,
    model: p.model,
    serial: p.serial,
    tagCode: p.tagCode,
    condition: p.condition,
    conditionReason: p.conditionReason,
    band: p.band,
    bandReason: p.bandReason,
    safety: p.safety,
    evidence: p.evidence,
    proposedBy: { kind: 'recogniser', model: ctx.model, prompt: PROMPT_VERSION, at: ctx.at },
    status: 'proposed',
    decision: null,
    history: [{ at: ctx.at, by: null, action: 'Proposed by the recogniser' }],
    notes: p.notes,
    registerId: null,
    version: 1,
  }));
}
