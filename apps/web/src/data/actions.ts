import { checkApproverSeparation, checkEditAfterApproval, checkWalkApproval, type ApproverCheck } from '@domesday/domain';
import { loadSeed, type Runtime } from '../runtime/runtime';
import type { Json } from '../runtime/types';
import { nowIso } from './derive';
import type { WalkBundle } from './store';
import type { Box, Correction, Followup, FollowupKind, HistoryEntry, Line, MatchAnswer, PersonId, ReportRecord, RoomDef, Site, Walk, WalkEvent } from './types';

/** Writes to the shared store. Every review action records who, when and what changed (DMS-053). */

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function seedStore(rt: Runtime): Promise<void> {
  const seed = await loadSeed();
  // The site document goes last: the app treats its arrival as "this copy has a site".
  const { 'site/main': site, ...rest } = seed.docs;
  for (const [path, data] of Object.entries(rest)) await rt.db.doc(path).set(data);
  if (site) await rt.db.doc('site/main').set(site);
}

export async function logEvent(rt: Runtime, walk: Walk, event: Omit<WalkEvent, 'at'>): Promise<void> {
  const events = [...(walk.events ?? []), { ...event, at: nowIso() }].slice(-60);
  await rt.db.doc(`walks/${walk.id}`).update({ events } as unknown as Json);
}

export async function skipRoom(rt: Runtime, bundle: WalkBundle, roomId: string, reason: string, by: PersonId): Promise<void> {
  const at = nowIso();
  await rt.db.doc(`walks/${bundle.walk.id}/rooms/${roomId}`).set({
    roomId,
    status: 'skipped',
    skipReason: reason.trim(),
    filmedBy: by,
    filmedAt: at,
    clip: null,
    frames: [],
    labelShots: [],
    analysis: { status: 'idle' },
    updatedAt: at,
  });
}

export async function unskipRoom(rt: Runtime, bundle: WalkBundle, roomId: string): Promise<void> {
  await rt.db.doc(`walks/${bundle.walk.id}/rooms/${roomId}`).set({
    roomId,
    status: 'not_started',
    skipReason: null,
    filmedBy: null,
    filmedAt: null,
    clip: null,
    frames: [],
    labelShots: [],
    analysis: { status: 'idle' },
    updatedAt: nowIso(),
  });
}

export async function addRoom(rt: Runtime, site: Site, bundle: WalkBundle, name: string, floor: string): Promise<RoomDef> {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  let id = base || 'room';
  let n = 2;
  while (site.rooms.some((r) => r.id === id)) id = `${base}-${n++}`;
  const room: RoomDef = { id, name: name.trim(), floor: floor.trim() || 'Floor not set', note: 'Added during this walk', sample: null };
  await rt.db.doc('site/main').update({ rooms: [...site.rooms, room] } as unknown as Json);
  await unskipRoom(rt, bundle, id);
  return room;
}

function history(line: Line, entry: Omit<HistoryEntry, 'at'>): HistoryEntry[] {
  return [...line.history, { ...entry, at: nowIso() }];
}

export type DecisionRefusal = { readonly ok: false; readonly message: string; readonly check?: ApproverCheck };
export type DecisionResult = { readonly ok: true } | DecisionRefusal;

/** DMS-054: the person who filmed a room cannot approve its lines (unless the rule is off). */
export function approverCheck(site: Site, bundle: WalkBundle, roomIds: readonly string[], approver: PersonId): ApproverCheck {
  const capturers = roomIds.map((r) => bundle.rooms.get(r)?.filmedBy).filter((x): x is string => Boolean(x));
  return checkApproverSeparation({
    separationRuleOn: site.separationRule,
    approverUserId: approver,
    capturerUserIds: capturers,
    eligibleReviewers: site.people.filter((p) => p.role === 'reviewer' || p.role === 'financial_controller').map((p) => ({ userId: p.id, displayName: p.name })),
  });
}

function refusal(site: Site, check: ApproverCheck, approver: PersonId): DecisionRefusal | null {
  if (check.allowed) return null;
  const name = site.people.find((p) => p.id === approver)?.name ?? 'You';
  const other = check.suggestedReviewer ? ` ${check.suggestedReviewer.displayName} can.` : '';
  return { ok: false, message: `${name} filmed this room, so they can't approve its lines.${other}`, check };
}

export async function acceptLine(rt: Runtime, site: Site, bundle: WalkBundle, line: Line, by: PersonId, opts: { bulk?: boolean } = {}): Promise<DecisionResult> {
  const r = refusal(site, approverCheck(site, bundle, [line.roomId], by), by);
  if (r) return r;
  const at = nowIso();
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${line.id}`).update({
    status: 'accepted',
    decision: { kind: opts.bulk ? 'bulk_approve' : 'accept', by, at, reason: null, bulk: Boolean(opts.bulk) },
    history: history(line, { by, action: opts.bulk ? 'Approved in bulk' : 'Accepted as proposed' }),
  } as unknown as Json);
  return { ok: true };
}

export async function rejectLine(rt: Runtime, site: Site, bundle: WalkBundle, line: Line, by: PersonId, reason: string): Promise<DecisionResult> {
  const r = refusal(site, approverCheck(site, bundle, [line.roomId], by), by);
  if (r) return r;
  const at = nowIso();
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${line.id}`).update({
    status: 'rejected',
    decision: { kind: 'reject', by, at, reason, bulk: false },
    history: history(line, { by, action: 'Rejected', reason }),
  } as unknown as Json);
  if (line.proposedBy.kind === 'recogniser') {
    await recordCorrection(rt, { kind: 'rejected', roomId: line.roomId, lineId: line.id, frameId: line.evidence[0]?.frameId ?? null, box: line.evidence[0]?.box ?? null, from: { categoryId: line.categoryId, description: line.description }, to: null, reason, by });
  }
  return { ok: true };
}

export type LinePatch = Partial<Pick<Line, 'categoryId' | 'description' | 'quantity' | 'kind' | 'condition' | 'conditionReason' | 'make' | 'model' | 'serial' | 'tagCode'>>;

/** Edit and accept. After the walk is approved an edit needs a reason and makes a new version (DMS-093). */
export async function editLine(
  rt: Runtime,
  site: Site,
  bundle: WalkBundle,
  line: Line,
  by: PersonId,
  patch: LinePatch,
  reason: string | null,
): Promise<DecisionResult> {
  const approved = bundle.walk.status === 'approved';
  const check = checkEditAfterApproval({ lineApproved: approved && line.status === 'accepted', reason });
  if (!check.ok) return { ok: false, message: 'This walk is approved, so an edit needs a reason. Earlier versions stay visible.' };
  const r = refusal(site, approverCheck(site, bundle, [line.roomId], by), by);
  if (r) return r;
  const changes: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(patch)) {
    const before = (line as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) changes[k] = [before ?? null, v ?? null];
  }
  const at = nowIso();
  const next: Record<string, unknown> = {
    ...patch,
    status: 'accepted',
    decision: { kind: 'edit', by, at, reason: reason ?? null, bulk: false },
    history: history(line, { by, action: approved ? 'Edited after approval' : 'Edited, then accepted', changes, reason }),
    version: approved ? line.version + 1 : line.version,
  };
  if (patch.quantity !== undefined) next.kind = patch.quantity > 1 ? 'counted_group' : 'single_item';
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${line.id}`).update(next as Json);
  const relabelled = (patch.categoryId !== undefined && patch.categoryId !== line.categoryId) || (patch.description !== undefined && patch.description !== line.description);
  if (relabelled && line.proposedBy.kind === 'recogniser') {
    await recordCorrection(rt, {
      kind: 'relabel',
      roomId: line.roomId,
      lineId: line.id,
      frameId: line.evidence[0]?.frameId ?? null,
      box: line.evidence[0]?.box ?? null,
      from: { categoryId: line.categoryId, description: line.description },
      to: { categoryId: patch.categoryId ?? line.categoryId, description: patch.description ?? line.description },
      reason,
      by,
    });
  }
  return { ok: true };
}

/** Undo a decision before the walk is approved, so the line goes back in the queue. */
export async function reopenLine(rt: Runtime, bundle: WalkBundle, line: Line, by: PersonId): Promise<void> {
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${line.id}`).update({
    status: 'proposed',
    decision: null,
    history: history(line, { by, action: 'Decision undone' }),
  } as unknown as Json);
}

/** DMS-051: merge two lines for the same item. One remains, with both frame sets. */
export async function mergeLines(rt: Runtime, site: Site, bundle: WalkBundle, keep: Line, absorb: Line, by: PersonId): Promise<DecisionResult> {
  const r = refusal(site, approverCheck(site, bundle, [keep.roomId, absorb.roomId], by), by);
  if (r) return r;
  const at = nowIso();
  const sameGroup = keep.categoryId === absorb.categoryId && (keep.kind === 'counted_group' || absorb.kind === 'counted_group');
  const quantity = sameGroup ? keep.quantity + absorb.quantity : keep.quantity;
  const evidence = [...keep.evidence, ...absorb.evidence.filter((e) => !keep.evidence.some((k) => k.frameId === e.frameId))];
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${keep.id}`).update({
    evidence,
    quantity,
    kind: quantity > 1 ? 'counted_group' : 'single_item',
    make: keep.make ?? absorb.make ?? null,
    model: keep.model ?? absorb.model ?? null,
    serial: keep.serial ?? absorb.serial ?? null,
    tagCode: keep.tagCode ?? absorb.tagCode ?? null,
    mergedFrom: [...(keep.mergedFrom ?? []), absorb.id],
    status: 'accepted',
    decision: { kind: 'merge', by, at, reason: null, bulk: false },
    history: history(keep, { by, action: `Merged with another line${sameGroup ? `, quantity now ${quantity}` : ''}` }),
  } as unknown as Json);
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${absorb.id}`).update({
    status: 'merged',
    mergedInto: keep.id,
    decision: { kind: 'merge', by, at, reason: null, bulk: false },
    history: history(absorb, { by, action: 'Merged into another line' }),
  } as unknown as Json);
  return { ok: true };
}

/** DMS-051: split one line into several. The parts go back in the queue for their own decisions. */
export async function splitLine(rt: Runtime, site: Site, bundle: WalkBundle, line: Line, by: PersonId, quantities: readonly number[]): Promise<DecisionResult> {
  const r = refusal(site, approverCheck(site, bundle, [line.roomId], by), by);
  if (r) return r;
  const at = nowIso();
  const ids: string[] = [];
  let i = 0;
  for (const q of quantities) {
    const id = newId(`l-${line.roomId}`);
    ids.push(id);
    i += 1;
    const part: Line = {
      ...line,
      id,
      createdAt: new Date(Date.now() + i).toISOString(),
      quantity: q,
      kind: q > 1 ? 'counted_group' : 'single_item',
      status: 'proposed',
      decision: null,
      splitFrom: line.id,
      splitInto: null,
      mergedFrom: [],
      history: [{ at, by, action: `Split from another line (${q} of ${line.quantity})` }],
      proposedBy: { kind: 'reviewer', at },
      version: 1,
    };
    await rt.db.doc(`walks/${bundle.walk.id}/lines/${id}`).set(part as unknown as Json);
  }
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${line.id}`).update({
    status: 'split',
    splitInto: ids,
    decision: { kind: 'split', by, at, reason: null, bulk: false },
    history: history(line, { by, action: `Split into ${quantities.length} lines` }),
  } as unknown as Json);
  return { ok: true };
}

export type WalkApprovalResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** DMS-058: approved only when every line has a decision and every room is filmed or skipped with a reason. */
export async function approveWalk(rt: Runtime, site: Site, bundle: WalkBundle, by: PersonId): Promise<WalkApprovalResult> {
  const check = checkWalkApproval({
    lines: bundle.lines.map((l) => ({ lineId: l.id, decision: l.status === 'proposed' ? null : (l.decision?.kind ?? 'accept') })),
    rooms: site.rooms.map((r) => {
      const v = bundle.rooms.get(r.id);
      return { roomId: r.id, status: v?.status ?? 'not_started', skipReason: v?.skipReason ?? null };
    }),
  });
  if (!check.ok) {
    const parts: string[] = [];
    if (check.undecidedLineIds.length) parts.push(`${check.undecidedLineIds.length} ${check.undecidedLineIds.length === 1 ? 'line still needs' : 'lines still need'} a decision`);
    if (check.roomsNotStarted.length) parts.push(`${check.roomsNotStarted.length} ${check.roomsNotStarted.length === 1 ? 'room is' : 'rooms are'} neither filmed nor skipped`);
    if (check.roomsSkippedWithoutReason.length) parts.push('a skipped room has no reason');
    return { ok: false, message: `Not yet: ${parts.join(', ')}.` };
  }
  const filmedRooms = [...bundle.rooms.values()].filter((r) => r.status === 'filmed').map((r) => r.roomId);
  const sep = approverCheck(site, bundle, filmedRooms, by);
  if (!sep.allowed) {
    const name = site.people.find((p) => p.id === by)?.name ?? 'You';
    return { ok: false, message: `${name} filmed rooms on this walk, so they can't be its sole approver.${sep.suggestedReviewer ? ` Ask ${sep.suggestedReviewer.displayName}.` : ''}` };
  }
  const at = nowIso();
  const events = [...bundle.walk.events, { at, by, kind: 'approved', text: 'Walk approved' }].slice(-60);
  await rt.db.doc(`walks/${bundle.walk.id}`).update({ status: 'approved', approvedAt: at, approvedBy: by, finishedAt: bundle.walk.finishedAt ?? at, events } as unknown as Json);
  return { ok: true };
}

export async function reopenWalk(rt: Runtime, bundle: WalkBundle, by: PersonId): Promise<void> {
  const events = [...bundle.walk.events, { at: nowIso(), by, kind: 'reopened', text: 'Approval withdrawn for more review' }].slice(-60);
  await rt.db.doc(`walks/${bundle.walk.id}`).update({ status: 'in_review', approvedAt: null, approvedBy: null, events } as unknown as Json);
}

export async function answerMatch(rt: Runtime, bundle: WalkBundle, answer: Omit<MatchAnswer, 'at'>): Promise<void> {
  const key = `${answer.registerId}__${answer.lineId}`.replace(/[^A-Za-z0-9_.~:@+-]/g, '_');
  await rt.db.doc(`walks/${bundle.walk.id}/matches/${key}`).set({ ...answer, at: nowIso() } as unknown as Json);
}

export async function addFollowup(
  rt: Runtime,
  bundle: WalkBundle,
  f: { kind: FollowupKind; title: string; lineId?: string | null; registerId?: string | null; roomId?: string | null; owner?: PersonId | null; due?: string | null; note?: string | null },
  by: PersonId,
): Promise<string> {
  const id = newId(f.kind);
  const doc: Omit<Followup, 'id'> = {
    kind: f.kind,
    title: f.title,
    lineId: f.lineId ?? null,
    registerId: f.registerId ?? null,
    roomId: f.roomId ?? null,
    owner: f.owner ?? null,
    due: f.due ?? null,
    status: 'open',
    outcome: null,
    note: f.note ?? null,
    createdAt: nowIso(),
    createdBy: by,
  };
  await rt.db.doc(`walks/${bundle.walk.id}/followups/${id}`).set(doc as unknown as Json);
  return id;
}

export async function requestRefilm(rt: Runtime, bundle: WalkBundle, roomId: string, by: PersonId, reason: string): Promise<void> {
  await rt.db.doc(`walks/${bundle.walk.id}/rooms/${roomId}`).update({ refilmRequested: { by, at: nowIso(), reason } } as unknown as Json);
}

export async function issueReport(rt: Runtime, record: ReportRecord): Promise<void> {
  await rt.db.doc(`reports/${record.code}`).set(record as unknown as Json);
}

/** Keep a reviewer's correction as a labelled example for this site (DMS-055). */
export async function recordCorrection(rt: Runtime, c: Omit<Correction, 'id' | 'at'>): Promise<void> {
  const id = newId('fix');
  await rt.db.doc(`corrections/${id}`).set({ ...c, id, at: nowIso() } as unknown as Json);
}

export interface MissedItem {
  readonly roomId: string;
  readonly frameId: string;
  readonly box: Box;
  readonly categoryId: string;
  readonly description: string;
  readonly quantity: number;
  readonly condition: Line['condition'];
  readonly conditionReason: string;
}

/** An admin labels an item the recogniser missed: a new accepted line with the box they drew. */
export async function addMissedLine(rt: Runtime, site: Site, bundle: WalkBundle, item: MissedItem, by: PersonId): Promise<DecisionResult> {
  const r = refusal(site, approverCheck(site, bundle, [item.roomId], by), by);
  if (r) return r;
  const at = nowIso();
  const id = newId(`l-${item.roomId}`);
  const line: Line = {
    id,
    walkId: bundle.walk.id,
    roomId: item.roomId,
    createdAt: at,
    kind: item.quantity > 1 ? 'counted_group' : 'single_item',
    quantity: item.quantity,
    categoryId: item.categoryId,
    description: item.description,
    make: null,
    model: null,
    serial: null,
    tagCode: null,
    condition: item.condition,
    conditionReason: item.conditionReason,
    band: 'high',
    bandReason: 'Labelled by a reviewer',
    safety: null,
    evidence: [{ frameId: item.frameId, box: item.box }],
    proposedBy: { kind: 'reviewer', at },
    status: 'accepted',
    decision: { kind: 'accept', by, at, reason: null, bulk: false },
    history: [{ at, by, action: 'Labelled by a reviewer: the recogniser missed it' }],
    notes: [],
    registerId: null,
    version: 1,
  };
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${id}`).set(line as unknown as Json);
  await recordCorrection(rt, { kind: 'missed', roomId: item.roomId, lineId: id, frameId: item.frameId, box: item.box, from: null, to: { categoryId: item.categoryId, description: item.description }, reason: null, by });
  return { ok: true };
}

/** An admin redraws the box around an item on one frame. */
export async function correctBox(rt: Runtime, site: Site, bundle: WalkBundle, line: Line, frameId: string, box: Box, by: PersonId): Promise<DecisionResult> {
  const r = refusal(site, approverCheck(site, bundle, [line.roomId], by), by);
  if (r) return r;
  const evidence = line.evidence.some((e) => e.frameId === frameId) ? line.evidence.map((e) => (e.frameId === frameId ? { ...e, box } : e)) : [...line.evidence, { frameId, box }];
  await rt.db.doc(`walks/${bundle.walk.id}/lines/${line.id}`).update({ evidence, history: history(line, { by, action: 'Box redrawn by a reviewer' }) } as unknown as Json);
  if (line.proposedBy.kind === 'recogniser') {
    await recordCorrection(rt, { kind: 'box', roomId: line.roomId, lineId: line.id, frameId, box, from: { categoryId: line.categoryId, description: line.description }, to: null, reason: null, by });
  }
  return { ok: true };
}

/** Roles that may label and correct the recogniser. */
export function canLabel(site: Site, personId: PersonId): boolean {
  const role = site.people.find((p) => p.id === personId)?.role;
  return role === 'reviewer' || role === 'financial_controller' || role === 'tenant_administrator' || role === 'facilities_manager';
}
