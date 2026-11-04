import type { Role } from '@domesday/domain';
import { loadSeed, type Runtime } from '../runtime/runtime';
import { pruneAssets } from '../runtime/media';
import type { Json } from '../runtime/types';
import { newId } from './actions';
import { nowIso } from './derive';
import type { WalkBundle } from './store';
import type { Category, Person, Register, RegisterEntry, RoomDef, Site, Walk } from './types';

/** Setting up a site of your own, starting the next walk, and clearing a copy back to empty. */

export interface RoleOption {
  readonly role: Role;
  readonly label: string;
  readonly duty: string;
}

export const ROLE_OPTIONS: readonly RoleOption[] = [
  { role: 'site_manager', label: 'Site manager', duty: 'Films the walks' },
  { role: 'reviewer', label: 'Reviewer', duty: 'Reviews and approves' },
  { role: 'financial_controller', label: 'Financial controller', duty: 'Reconciles and issues reports' },
  { role: 'facilities_manager', label: 'Facilities manager', duty: 'Runs the walks and checks the lines' },
  { role: 'tenant_administrator', label: 'Administrator', duty: 'Sets up the site and its people' },
  { role: 'internal_auditor', label: 'Internal auditor', duty: 'Reads everything, changes nothing' },
];

export function roleOption(role: Role): RoleOption {
  return ROLE_OPTIONS.find((r) => r.role === role) ?? { role, label: role, duty: '' };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const two = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}` : (parts[0] ?? '?').slice(0, 2);
  return two.toUpperCase();
}

export function makePerson(name: string, role: Role, taken: readonly string[]): Person {
  const base =
    name
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'person';
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  const opt = roleOption(role);
  return { id, name: name.trim(), initials: initialsOf(name), role, roleLabel: opt.label, duty: opt.duty };
}

export function slug(s: string, fallback: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || fallback
  );
}

export function makeRoom(name: string, floor: string, taken: readonly string[]): RoomDef {
  const base = slug(name, 'room');
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return { id, name: name.trim(), floor: floor.trim() || 'Floor not set', sample: null };
}

function emptyVisit(roomId: string, at: string): Json {
  return { roomId, status: 'not_started', skipReason: null, filmedBy: null, filmedAt: null, clip: null, frames: [], labelShots: [], analysis: { status: 'idle' }, updatedAt: at };
}

function newWalk(id: string, siteId: string, previousWalkId: string | null, label: string): Walk {
  return { id, siteId, label, status: 'capturing', startedAt: null, finishedAt: null, capturedBy: [], approvedAt: null, approvedBy: null, previousWalkId, demoHistory: false, events: [] };
}

/** The asset categories every new site starts with: the same list the demo uses. */
export async function defaultCategories(): Promise<Category[]> {
  const seed = await loadSeed();
  const site = seed.docs['site/main'] as unknown as Site | undefined;
  return site ? [...site.categories] : [{ id: 'other', name: 'Other asset', plural: 'other assets' }];
}

export interface NewSite {
  readonly name: string;
  readonly city: string;
  readonly rooms: readonly RoomDef[];
  readonly people: readonly Person[];
  readonly register: { readonly fileName: string; readonly entries: readonly RegisterEntry[] } | null;
  readonly thresholdKobo: number | null;
  readonly separationRule: boolean;
  readonly by: string;
}

/** The documents a new site starts with: no walk history, its first walk ready to film. */
export async function buildSiteDocs(input: NewSite): Promise<Record<string, Json>> {
  const at = nowIso();
  const siteId = slug(input.name, 'site');
  const walkId = newId('w');
  const site: Site = {
    id: siteId,
    name: input.name.trim(),
    city: input.city.trim() || 'City not set',
    currency: 'NGN',
    thresholdKobo: input.thresholdKobo,
    separationRule: input.separationRule,
    rooms: input.rooms,
    people: input.people,
    categories: await defaultCategories(),
    currentWalkId: walkId,
    previousWalkId: null,
    registerImportedAt: input.register ? at.slice(0, 10) : null,
    demo: false,
    cameras: [],
  };
  const docs: Record<string, Json> = {
    'site/main': site as unknown as Json,
    [`walks/${walkId}`]: newWalk(walkId, siteId, null, 'First walk') as unknown as Json,
  };
  for (const r of input.rooms) docs[`walks/${walkId}/rooms/${r.id}`] = emptyVisit(r.id, at);
  if (input.register) {
    const reg: Register = { importedAt: at, importedBy: input.by, fileName: input.register.fileName, lines: input.register.entries };
    docs['register/main'] = reg as unknown as Json;
  }
  return docs;
}

export async function createSite(rt: Runtime, input: NewSite): Promise<void> {
  const docs = await buildSiteDocs(input);
  // The site document goes last: the app treats its arrival as "this copy has a site".
  const { 'site/main': siteDoc, ...rest } = docs;
  for (const [path, data] of Object.entries(rest)) await rt.db.doc(path).set(data);
  if (siteDoc) await rt.db.doc('site/main').set(siteDoc);
}

/** After a walk is approved: it becomes the walk the next one is compared against. */
export async function startNextWalk(rt: Runtime, site: Site, current: WalkBundle, by: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (current.walk.status !== 'approved') return { ok: false, message: 'Approve this walk first. The next walk is compared against it.' };
  const at = nowIso();
  const id = newId('w');
  const next = newWalk(id, site.id, current.walk.id, 'Monthly walk');
  await rt.db.doc(`walks/${id}`).set({ ...next, events: [{ at, by, kind: 'created', text: 'Walk created' }] } as unknown as Json);
  for (const r of site.rooms) await rt.db.doc(`walks/${id}/rooms/${r.id}`).set(emptyVisit(r.id, at));
  await rt.db.doc('site/main').update({ previousWalkId: current.walk.id, currentWalkId: id } as unknown as Json);
  return { ok: true };
}

const WALK_PARTS = ['rooms', 'lines', 'matches', 'followups'] as const;

async function deleteWalk(rt: Runtime, walkId: string): Promise<void> {
  for (const sub of WALK_PARTS) {
    const snap = await rt.db.collection(`walks/${walkId}/${sub}`).get();
    for (const d of snap.docs) await rt.db.doc(`walks/${walkId}/${sub}/${d.id}`).delete();
  }
  await rt.db.doc(`walks/${walkId}`).delete();
}

/** Every walk the store knows about: the listing, plus each walk's chain of previous walks. */
async function walkIds(rt: Runtime, site: Site | null, extra: readonly string[] = []): Promise<Set<string>> {
  const ids = new Set<string>();
  const top = await rt.db.collection('walks').get();
  const queue = [...top.docs.map((d) => d.id), site?.currentWalkId, site?.previousWalkId, ...extra].filter((x): x is string => Boolean(x));
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const snap = await rt.db.doc(`walks/${id}`).get();
    if (!snap.exists) continue;
    ids.add(id);
    const prev = (snap.data() as unknown as Walk).previousWalkId;
    if (prev) queue.push(prev);
  }
  return ids;
}

/** Empty this copy: no site, no walks, no register, no reports. Uploaded frames are removed too. */
export async function clearEverything(rt: Runtime, site: Site | null): Promise<void> {
  for (const id of await walkIds(rt, site)) await deleteWalk(rt, id);
  for (const coll of ['reports', 'corrections', 'camera-checks']) {
    const snap = await rt.db.collection(coll).get();
    for (const d of snap.docs) await rt.db.doc(`${coll}/${d.id}`).delete();
  }
  await rt.db.doc('register/main').delete();
  await rt.db.doc('site/main').delete();
  await pruneAssets(rt, new Set());
}

/**
 * Put the demo back to the start: the 3 October walk, the register and an empty current walk.
 * Walks a demo run started after approving are removed too, and so are reports, labels and
 * camera checks, so every run of the demo starts the same.
 */
export async function resetDemo(rt: Runtime, site: Site): Promise<void> {
  const seed = await loadSeed();
  const keep = new Set([seed.currentWalkId, seed.previousWalkId]);
  for (const id of await walkIds(rt, site, [...keep])) {
    if (keep.has(id)) {
      for (const sub of WALK_PARTS) {
        const snap = await rt.db.collection(`walks/${id}/${sub}`).get();
        for (const d of snap.docs) await rt.db.doc(`walks/${id}/${sub}/${d.id}`).delete();
      }
    } else await deleteWalk(rt, id);
  }
  for (const coll of ['reports', 'corrections', 'camera-checks']) {
    const snap = await rt.db.collection(coll).get();
    for (const d of snap.docs) await rt.db.doc(`${coll}/${d.id}`).delete();
  }
  for (const [path, data] of Object.entries(seed.docs)) await rt.db.doc(path).set(data);
  // Frames uploaded during the demo are no longer pointed at by any document.
  await pruneAssets(rt, new Set());
}
