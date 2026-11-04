import { ConditionGrade, type ConditionGrade as Grade } from '@domesday/domain';
import { acceptLine, addFollowup, addRoom, editLine, rejectLine, skipRoom, type LinePatch } from '../data/actions';
import { categoryName, lineNo, roomName } from '../data/derive';
import { matchCategory, matchRoom } from '../data/register-import';
import type { AppData, WalkBundle } from '../data/store';
import type { FollowupKind, Line, PersonId, Site } from '../data/types';
import type { Json } from '../runtime/types';

/**
 * Changes the assistant may propose. It never makes them: it writes them in a <changes> block
 * at the end of its answer, each one is checked here against the site, shown as a card, and
 * only applied when the person taps Apply, through the same actions the screens use, so the
 * separation rule, approval rules and the audit history all still apply.
 */

export type ResolvedChange =
  | { readonly action: 'edit_line'; readonly lineId: string; readonly patch: LinePatch; readonly reason: string | null }
  | { readonly action: 'accept_line'; readonly lineId: string }
  | { readonly action: 'reject_line'; readonly lineId: string; readonly reason: string }
  | {
      readonly action: 'add_followup';
      readonly kind: Extract<FollowupKind, 'investigation' | 'maintenance' | 'safety'>;
      readonly title: string;
      readonly lineId: string | null;
      readonly registerId: string | null;
      readonly roomId: string | null;
      readonly owner: PersonId | null;
      readonly due: string | null;
    }
  | { readonly action: 'add_room'; readonly name: string; readonly floor: string }
  | { readonly action: 'rename_room'; readonly roomId: string; readonly name: string; readonly floor: string | null }
  | { readonly action: 'skip_room'; readonly roomId: string; readonly reason: string };

export const CHANGE_ACTIONS = ['edit_line', 'accept_line', 'reject_line', 'add_followup', 'add_room', 'rename_room', 'skip_room'] as const;

/** The part of the instructions that teaches the change format, for a person allowed to make changes. */
export function changeProtocol(site: Site): string {
  return `CHANGES
You can propose changes to this site's current walk. Nothing changes until the person taps Apply on each one, and Domesday records who made it.
Only propose a change when the person asks for one. Say in one short sentence what you propose, then put the exact changes at the very end of your reply, in this form and nothing after it:
<changes>
[{"action":"edit_line","line":"014","set":{"description":"Mesh office chair","category":"office-chair","quantity":2,"condition":"fair","condition_reason":"Torn armrest"},"reason":"Recogniser called it a stool"}]
</changes>
Actions:
- edit_line: line (its number), set (only what changes: description, category as an id from the list below, quantity, condition as good, fair, poor or not_working_or_unsafe, condition_reason), reason. Editing also accepts the line.
- accept_line: line.
- reject_line: line, reason.
- add_followup: kind (investigation, maintenance or safety), title; optionally line, register (an ID such as FA-0412), room (a room name), owner (a person's name), due (YYYY-MM-DD).
- add_room: name, floor.
- rename_room: room (its current name), name; optionally floor.
- skip_room: room, reason. Only for a room not filmed yet.
Use line numbers from ASSET LINES ON THIS WALK only; lines from the last walk can't be changed. If a change can't be made (the walk is approved and the person gave no reason for an edit, or a room was already filmed), say why instead of proposing it.
Categories (id: name): ${site.categories.map((c) => `${c.id}: ${c.name}`).join('; ')}`;
}

export const NO_CHANGES = `CHANGES
You can't change anything from here. If the person asks for a change, say how to do it in Domesday (Review for lines, Site setup for rooms and people), or that a person whose role allows it can switch on "Let the assistant make changes" at the top of this panel.`;

const OPEN = '<changes>';
const CLOSE = '</changes>';

/** The text to show (without the change block, even while it is still arriving) and the block's JSON, if complete. */
export function splitAnswer(text: string): { readonly display: string; readonly raw: unknown[] | null; readonly broken: boolean } {
  const start = text.indexOf(OPEN);
  if (start < 0) {
    // While streaming, a block may have started without its full opening tag yet.
    const partial = /<c(?:h(?:a(?:n(?:g(?:e(?:s)?)?)?)?)?)?$/.exec(text);
    return { display: (partial ? text.slice(0, partial.index) : text).trimEnd(), raw: null, broken: false };
  }
  const display = text.slice(0, start).trimEnd();
  const end = text.indexOf(CLOSE, start);
  if (end < 0) return { display, raw: null, broken: false };
  const body = text
    .slice(start + OPEN.length, end)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const parsed: unknown = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return { display, raw: list, broken: false };
  } catch {
    return { display, raw: null, broken: true };
  }
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function findLine(bundle: WalkBundle, ref: unknown): Line | null {
  const digits = String(ref ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  const line = bundle.lines[n - 1];
  return line && (line.status === 'proposed' || line.status === 'accepted') ? line : null;
}

function findRoom(site: Site, ref: unknown): string | null {
  const name = str(ref);
  if (!name) return null;
  const exact = site.rooms.find((r) => r.name.toLowerCase() === name.toLowerCase() || r.id === name);
  return exact?.id ?? matchRoom(name, site.rooms);
}

function findPerson(site: Site, ref: unknown): PersonId | null {
  const name = str(ref).toLowerCase();
  if (!name) return null;
  const p = site.people.find((x) => x.name.toLowerCase() === name || x.id === name) ?? site.people.find((x) => x.name.toLowerCase().split(' ')[0] === name.split(' ')[0]);
  return p?.id ?? null;
}

/** Checks every proposed change against the site. Anything that doesn't fit is reported, not applied. */
export function resolveChanges(raw: readonly unknown[], data: AppData): { readonly changes: ResolvedChange[]; readonly problems: string[] } {
  const { site, current } = data;
  const changes: ResolvedChange[] = [];
  const problems: string[] = [];
  if (!site || !current) return { changes, problems: ['There is no walk to change.'] };
  for (const item of raw.slice(0, 12)) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const action = str(o.action, 40);
    switch (action) {
      case 'edit_line': {
        const line = findLine(current, o.line);
        if (!line) {
          problems.push(`Line ${str(o.line, 8) || '?'} isn't a line on this walk.`);
          break;
        }
        const set = (o.set && typeof o.set === 'object' ? o.set : {}) as Record<string, unknown>;
        const patch: { -readonly [K in keyof LinePatch]: LinePatch[K] } = {};
        const description = str(set.description, 160);
        if (description) patch.description = description;
        if (set.category !== undefined) {
          const c = str(set.category, 80);
          const id = site.categories.some((x) => x.id === c) ? c : matchCategory(c, site.categories);
          if (id) patch.categoryId = id;
          else problems.push(`"${c}" isn't one of this site's categories.`);
        }
        if (set.quantity !== undefined) {
          const q = Math.round(Number(set.quantity));
          if (Number.isFinite(q) && q >= 1 && q <= 10000) patch.quantity = q;
          else problems.push(`${str(String(set.quantity), 12)} isn't a quantity.`);
        }
        if (set.condition !== undefined) {
          const g = str(set.condition, 40).toLowerCase().replace(/[\s-]+/g, '_');
          if ((ConditionGrade.values as readonly string[]).includes(g)) patch.condition = g as Grade;
          else problems.push(`"${str(set.condition, 40)}" isn't a condition grade.`);
        }
        const reasonText = str(set.condition_reason, 160);
        if (reasonText) patch.conditionReason = reasonText;
        if (!Object.keys(patch).length) {
          problems.push(`Nothing to change on Line ${lineNo(current, line.id)}.`);
          break;
        }
        changes.push({ action: 'edit_line', lineId: line.id, patch, reason: str(o.reason, 200) || null });
        break;
      }
      case 'accept_line':
      case 'reject_line': {
        const line = findLine(current, o.line);
        if (!line) {
          problems.push(`Line ${str(o.line, 8) || '?'} isn't a line on this walk.`);
          break;
        }
        if (action === 'accept_line') changes.push({ action, lineId: line.id });
        else changes.push({ action, lineId: line.id, reason: str(o.reason, 200) || 'Rejected through Ask Domesday' });
        break;
      }
      case 'add_followup': {
        const kind = str(o.kind, 20).toLowerCase();
        if (kind !== 'investigation' && kind !== 'maintenance' && kind !== 'safety') {
          problems.push(`"${kind}" isn't a kind of follow-up.`);
          break;
        }
        const title = str(o.title, 160);
        if (!title) {
          problems.push('A follow-up needs a title.');
          break;
        }
        const line = o.line !== undefined ? findLine(current, o.line) : null;
        const registerId = str(o.register, 40) || null;
        const due = /^\d{4}-\d{2}-\d{2}$/.test(str(o.due, 10)) ? str(o.due, 10) : null;
        changes.push({ action: 'add_followup', kind, title, lineId: line?.id ?? null, registerId, roomId: findRoom(site, o.room) ?? line?.roomId ?? null, owner: findPerson(site, o.owner), due });
        break;
      }
      case 'add_room': {
        const name = str(o.name, 80);
        if (!name) problems.push('A new room needs a name.');
        else if (site.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())) problems.push(`${name} is already a room.`);
        else changes.push({ action: 'add_room', name, floor: str(o.floor, 40) || 'Floor not set' });
        break;
      }
      case 'rename_room': {
        const roomId = findRoom(site, o.room);
        const name = str(o.name, 80);
        if (!roomId) problems.push(`"${str(o.room, 80)}" isn't a room here.`);
        else if (!name) problems.push('A renamed room needs its new name.');
        else changes.push({ action: 'rename_room', roomId, name, floor: str(o.floor, 40) || null });
        break;
      }
      case 'skip_room': {
        const roomId = findRoom(site, o.room);
        const reason = str(o.reason, 160);
        const visit = roomId ? current.rooms.get(roomId) : undefined;
        if (!roomId) problems.push(`"${str(o.room, 80)}" isn't a room here.`);
        else if (visit && visit.status !== 'not_started') problems.push(`${roomName(site, roomId)} is already ${visit.status === 'filmed' ? 'filmed' : 'skipped'}.`);
        else if (!reason) problems.push('Skipping a room needs a reason.');
        else changes.push({ action: 'skip_room', roomId, reason });
        break;
      }
      default:
        problems.push(`"${action || 'unknown'}" isn't a change the assistant can make.`);
    }
  }
  return { changes, problems };
}

/** One line a person can read before tapping Apply. */
export function describeChange(c: ResolvedChange, site: Site, bundle: WalkBundle): { title: string; detail: string } {
  const line = 'lineId' in c && c.lineId ? bundle.lines.find((l) => l.id === c.lineId) : undefined;
  const ref = line ? `Line ${lineNo(bundle, line.id)}` : 'a line';
  switch (c.action) {
    case 'edit_line': {
      const parts: string[] = [];
      if (c.patch.description !== undefined) parts.push(`description "${line?.description ?? ''}" to "${c.patch.description}"`);
      if (c.patch.categoryId !== undefined) parts.push(`category ${categoryName(site, line?.categoryId)} to ${categoryName(site, c.patch.categoryId)}`);
      if (c.patch.quantity !== undefined) parts.push(`quantity ${line?.quantity ?? '?'} to ${c.patch.quantity}`);
      if (c.patch.condition !== undefined) parts.push(`condition ${(line?.condition ?? '').replace(/_/g, ' ')} to ${c.patch.condition.replace(/_/g, ' ')}`);
      if (c.patch.conditionReason !== undefined) parts.push(`condition reason "${c.patch.conditionReason}"`);
      return { title: `Edit ${ref} and accept it`, detail: `${parts.join('; ')}.${c.reason ? ` Reason: ${c.reason}` : ''}` };
    }
    case 'accept_line':
      return { title: `Accept ${ref}`, detail: line ? `${categoryName(site, line.categoryId)}: ${line.description}, ${roomName(site, line.roomId)}` : '' };
    case 'reject_line':
      return { title: `Reject ${ref}`, detail: `${line ? `${line.description}. ` : ''}Reason: ${c.reason}` };
    case 'add_followup':
      return {
        title: `Add ${c.kind === 'investigation' ? 'an investigation' : `a ${c.kind} item`}`,
        detail: `${c.title}${c.owner ? `, owner ${site.people.find((p) => p.id === c.owner)?.name ?? c.owner}` : ''}${c.due ? `, due ${c.due}` : ''}${c.roomId ? `, ${roomName(site, c.roomId)}` : ''}${c.registerId ? `, ${c.registerId}` : ''}`,
      };
    case 'add_room':
      return { title: `Add the room ${c.name}`, detail: `${c.floor}. It joins the current walk, ready to film.` };
    case 'rename_room':
      return { title: `Rename ${roomName(site, c.roomId)}`, detail: `to ${c.name}${c.floor ? `, ${c.floor}` : ''}` };
    case 'skip_room':
      return { title: `Skip ${roomName(site, c.roomId)} on this walk`, detail: `Reason: ${c.reason}` };
  }
}

/** Apply one change as the person on this device, through the screens' own actions. */
export async function applyChange(c: ResolvedChange, data: AppData, by: PersonId): Promise<{ ok: boolean; message: string }> {
  const { rt, site, current } = data;
  if (!site || !current) return { ok: false, message: 'There is no walk to change.' };
  const line = 'lineId' in c && c.lineId ? current.lines.find((l) => l.id === c.lineId) : undefined;
  const label = line ? `Line ${lineNo(current, line.id)}` : '';
  switch (c.action) {
    case 'edit_line': {
      if (!line) return { ok: false, message: 'That line is no longer on the walk.' };
      const r = await editLine(rt, site, current, line, by, c.patch, c.reason);
      return r.ok ? { ok: true, message: `${label} edited and accepted` } : r;
    }
    case 'accept_line': {
      if (!line) return { ok: false, message: 'That line is no longer on the walk.' };
      const r = await acceptLine(rt, site, current, line, by);
      return r.ok ? { ok: true, message: `${label} accepted` } : r;
    }
    case 'reject_line': {
      if (!line) return { ok: false, message: 'That line is no longer on the walk.' };
      const r = await rejectLine(rt, site, current, line, by, c.reason);
      return r.ok ? { ok: true, message: `${label} rejected` } : r;
    }
    case 'add_followup':
      await addFollowup(rt, current, { kind: c.kind, title: c.title, lineId: c.lineId, registerId: c.registerId, roomId: c.roomId, owner: c.owner, due: c.due, note: 'Added through Ask Domesday' }, by);
      return { ok: true, message: c.kind === 'investigation' ? 'Investigation added' : `Added to the ${c.kind} list` };
    case 'add_room': {
      const room = await addRoom(rt, site, current, c.name, c.floor);
      return { ok: true, message: `${room.name} added to the walk` };
    }
    case 'rename_room':
      await rt.db.doc('site/main').update({ rooms: site.rooms.map((r) => (r.id === c.roomId ? { ...r, name: c.name, floor: c.floor ?? r.floor } : r)) } as unknown as Json);
      return { ok: true, message: `Room renamed to ${c.name}` };
    case 'skip_room':
      if (current.walk.status === 'approved') return { ok: false, message: 'This walk is approved, so rooms can no longer be skipped.' };
      await skipRoom(rt, current, c.roomId, c.reason, by);
      return { ok: true, message: `${roomName(site, c.roomId)} skipped` };
  }
}
