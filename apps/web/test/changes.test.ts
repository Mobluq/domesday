/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyChange, describeChange, resolveChanges, splitAnswer } from '../src/ai/changes';
import type { AppData, WalkBundle } from '../src/data/store';
import type { Line, Register, RoomVisit, Site, Walk } from '../src/data/types';
import { MemoryDb } from '../src/runtime/memory-db';
import type { Runtime } from '../src/runtime/runtime';
import type { Json } from '../src/runtime/types';

const seed = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'seed.json'), 'utf8')) as { docs: Record<string, Json> };
const site = seed.docs['site/main'] as unknown as Site;
const register = seed.docs['register/main'] as unknown as Register;
const prefix = 'walks/w-2026-10-03/';

/** The 3 October walk, reopened: its lines waiting for a decision, Store room B not filmed yet. */
function setup(): { data: AppData; db: MemoryDb } {
  const db = new MemoryDb();
  const walk = { ...(seed.docs['walks/w-2026-10-03'] as unknown as Walk), status: 'in_review' as const, approvedAt: null, approvedBy: null };
  const lines = Object.entries(seed.docs)
    .filter(([k]) => k.startsWith(`${prefix}lines/`))
    .map(([, v]) => ({ ...(v as unknown as Line), status: 'proposed' as const, decision: null }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const rooms = new Map<string, RoomVisit>();
  for (const [k, v] of Object.entries(seed.docs)) if (k.startsWith(`${prefix}rooms/`)) rooms.set((v as unknown as RoomVisit).roomId, v as unknown as RoomVisit);
  rooms.set('store-b', { ...(rooms.get('store-b') as RoomVisit), status: 'not_started', filmedBy: null });
  for (const l of lines) void db.doc(`walks/${walk.id}/lines/${l.id}`).set(l as unknown as Json);
  void db.doc('site/main').set(site as unknown as Json);
  const bundle: WalkBundle = { walk, rooms, lines, matches: [], followups: [] };
  const rt = { mode: 'local', shared: false, db, assets: null, sample: null, imageLimits: null, downloads: null, seededLocally: false, ai: false, needsAccessCode: false } as Runtime;
  return { db, data: { rt, site: { ...site, separationRule: true }, register, current: bundle, previous: null, reports: [], cameraChecks: [], corrections: [], loaded: true } };
}

describe('changes the assistant proposes', () => {
  it('Separates the answer from its change block, even while it is still streaming', () => {
    const done = splitAnswer('I can fix that.\n<changes>\n```json\n[{"action":"accept_line","line":"001"}]\n```\n</changes>');
    expect(done.display).toBe('I can fix that.');
    expect(done.raw).toEqual([{ action: 'accept_line', line: '001' }]);
    expect(splitAnswer('I can fix that.\n<chan').display).toBe('I can fix that.');
    expect(splitAnswer('I can fix that.\n<changes>[{"action":').raw).toBeNull();
    expect(splitAnswer('Fixing.\n<changes>[{oops}]</changes>').broken).toBe(true);
  });

  it('Checks every change against the site and explains what it leaves out', () => {
    const { data } = setup();
    const { changes, problems } = resolveChanges(
      [
        { action: 'edit_line', line: '001', set: { description: 'Samsung television, wall-mounted', category: 'Television', condition: 'Fair', condition_reason: 'Scratched bezel' }, reason: 'Wrong make' },
        { action: 'reject_line', line: 'Line 002', reason: 'Duplicate' },
        { action: 'edit_line', line: '099', set: { quantity: 2 } },
        { action: 'add_followup', kind: 'investigation', title: 'Find the projector', owner: 'Tolu', due: '2026-11-11', room: 'boardroom' },
        { action: 'skip_room', room: 'Room 204', reason: 'Locked' },
        { action: 'skip_room', room: 'Store room B', reason: 'Locked, key with security' },
        { action: 'delete_everything' },
      ],
      data,
    );
    expect(changes.map((c) => c.action)).toEqual(['edit_line', 'reject_line', 'add_followup', 'skip_room']);
    expect(changes[0]).toMatchObject({ patch: { categoryId: 'television', condition: 'fair', conditionReason: 'Scratched bezel' }, reason: 'Wrong make' });
    expect(changes[2]).toMatchObject({ owner: 'tolu', roomId: 'boardroom', due: '2026-11-11' });
    expect(problems.join(' ')).toMatch(/Line 099 isn't a line/);
    expect(problems.join(' ')).toMatch(/Room 204 is already filmed/);
    expect(problems.join(' ')).toMatch(/"delete_everything" isn't a change/);
    const d = describeChange(changes[0] as (typeof changes)[number], data.site as Site, data.current as WalkBundle);
    expect(d.title).toBe('Edit Line 001 and accept it');
    expect(d.detail).toContain('condition good to fair');
  });

  it('Applies a change only through the normal actions, so the rules and the history still apply', async () => {
    const { data, db } = setup();
    const bundle = data.current as WalkBundle;
    const first = bundle.lines[0] as Line;
    const room = bundle.rooms.get(first.roomId);
    const { changes } = resolveChanges([{ action: 'edit_line', line: '001', set: { quantity: 2 }, reason: 'Two in the room' }], data);
    // The person who filmed the room may not approve its lines.
    const refused = await applyChange(changes[0] as (typeof changes)[number], data, room?.filmedBy ?? 'tolu');
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/filmed this room/);
    const ok = await applyChange(changes[0] as (typeof changes)[number], data, 'chinedu');
    expect(ok).toEqual({ ok: true, message: 'Line 001 edited and accepted' });
    const saved = (await db.doc(`walks/${bundle.walk.id}/lines/${first.id}`).get()).data() as unknown as Line;
    expect(saved).toMatchObject({ quantity: 2, kind: 'counted_group', status: 'accepted' });
    expect(saved.history.at(-1)).toMatchObject({ by: 'chinedu', action: 'Edited, then accepted' });
  });
});
