import { describe, expect, it } from 'vitest';
import {
  compareWalks,
  comparisonHeadline,
  describeGroupQuantity,
  describeQuantityDelta,
  matchLinesAcrossWalks,
  type ComparableLine,
} from '../src';

const SITE = 'site-a';

function line(overrides: Partial<ComparableLine> & { lineId: string }): ComparableLine {
  return {
    siteId: SITE,
    roomId: 'room-1',
    categoryId: 'projector',
    kind: 'single_item',
    quantity: 1,
    condition: 'good',
    ...overrides,
  };
}

describe('DMS-071: change status between two walks', () => {
  it('Given a projector present in walk 1 and absent in walk 2 with its room filmed, then it is "not seen"', () => {
    const result = compareWalks({
      before: [line({ lineId: 'w1-projector', serial: 'PJ-001' })],
      after: [],
      filmedRoomIds: ['room-1'],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'not_seen', beforeLineId: 'w1-projector', afterLineId: null });
  });

  it('If its room was not filmed, then it is "room not filmed", never "not seen"', () => {
    const result = compareWalks({
      before: [line({ lineId: 'w1-projector', serial: 'PJ-001' })],
      after: [],
      filmedRoomIds: ['room-2'],
    });
    expect(result.items[0]?.status).toBe('room_not_filmed');
    expect(result.countsByStatus.not_seen).toBe(0);
    expect(result.roomNotFilmedCount).toBe(1);
    expect(result.changeCount).toBe(0);
  });

  it('An item that appears for the first time is "new"', () => {
    const result = compareWalks({ before: [], after: [line({ lineId: 'w2-ac', categoryId: 'split_ac' })], filmedRoomIds: ['room-1'] });
    expect(result.items[0]).toMatchObject({ status: 'new', afterLineId: 'w2-ac', beforeLineId: null });
  });

  it('An item found in another room by its tag is "moved", with both places', () => {
    const result = compareWalks({
      before: [line({ lineId: 'w1-gen', categoryId: 'generator', tagCode: 'DMS-00042', roomId: 'room-1' })],
      after: [line({ lineId: 'w2-gen', categoryId: 'generator', tagCode: 'dms-00042 ', roomId: 'room-7' })],
      filmedRoomIds: ['room-1', 'room-7'],
    });
    expect(result.items[0]).toMatchObject({
      status: 'moved',
      matchedBy: 'tag',
      from: { siteId: SITE, roomId: 'room-1' },
      to: { siteId: SITE, roomId: 'room-7' },
    });
  });

  it('An item last seen here and now seen at another site by serial is "moved" to that site', () => {
    const result = compareWalks({
      before: [line({ lineId: 'a-gen', categoryId: 'generator', serial: 'SN 778899' })],
      after: [],
      filmedRoomIds: ['room-1'],
      otherSiteLines: [line({ lineId: 'b-gen', siteId: 'site-b', roomId: 'room-b1', categoryId: 'generator', serial: 'SN778899' })],
    });
    expect(result.items[0]).toMatchObject({ status: 'moved', matchedBy: 'serial', to: { siteId: 'site-b', roomId: 'room-b1' } });
  });

  it('A worse grade is "condition worse" and a better grade is "condition better"', () => {
    const worse = compareWalks({
      before: [line({ lineId: 'b', categoryId: 'split_ac', serial: 'AC1', condition: 'good' })],
      after: [line({ lineId: 'a', categoryId: 'split_ac', serial: 'AC1', condition: 'poor' })],
      filmedRoomIds: ['room-1'],
    });
    expect(worse.items[0]?.status).toBe('condition_worse');
    const better = compareWalks({
      before: [line({ lineId: 'b', categoryId: 'split_ac', serial: 'AC1', condition: 'not_working_or_unsafe' })],
      after: [line({ lineId: 'a', categoryId: 'split_ac', serial: 'AC1', condition: 'fair' })],
      filmedRoomIds: ['room-1'],
    });
    expect(better.items[0]?.status).toBe('condition_better');
  });

  it('A moved item that also got worse keeps "moved" and records the condition change beside it', () => {
    const result = compareWalks({
      before: [line({ lineId: 'b', serial: 'X1', roomId: 'room-1', condition: 'good' })],
      after: [line({ lineId: 'a', serial: 'X1', roomId: 'room-2', condition: 'poor' })],
      filmedRoomIds: ['room-1', 'room-2'],
    });
    expect(result.items[0]).toMatchObject({ status: 'moved', conditionChange: 'worse' });
  });
});

describe('DMS-072: matching untagged assets across walks', () => {
  it('Given an untagged desk moved within the same room, then it is matched as unchanged, not as one missing and one new', () => {
    const result = compareWalks({
      before: [line({ lineId: 'w1-desk', categoryId: 'desk', position: { x: 0.2, y: 0.3 } })],
      after: [line({ lineId: 'w2-desk', categoryId: 'desk', position: { x: 0.35, y: 0.4 } })],
      filmedRoomIds: ['room-1'],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ status: 'unchanged', matchedBy: 'category_appearance_position' });
  });

  it('Uses appearance to tell two desks in one room apart', () => {
    const { pairs } = matchLinesAcrossWalks(
      [
        line({ lineId: 'b-oak', categoryId: 'desk', appearance: [1, 0, 0] }),
        line({ lineId: 'b-steel', categoryId: 'desk', appearance: [0, 1, 0] }),
      ],
      [
        line({ lineId: 'a-steel', categoryId: 'desk', appearance: [0.05, 0.99, 0] }),
        line({ lineId: 'a-oak', categoryId: 'desk', appearance: [0.98, 0.1, 0] }),
      ],
    );
    const byBefore = Object.fromEntries(pairs.map((p) => [p.before.lineId, p.after.lineId]));
    expect(byBefore).toEqual({ 'b-oak': 'a-oak', 'b-steel': 'a-steel' });
  });

  it('Matches by serial before appearance, and never pairs lines whose read serials conflict', () => {
    const { pairs, unmatchedBefore, unmatchedAfter } = matchLinesAcrossWalks(
      [line({ lineId: 'b', categoryId: 'laptop', serial: 'AAA', appearance: [1, 0] })],
      [line({ lineId: 'a', categoryId: 'laptop', serial: 'BBB', appearance: [1, 0] })],
    );
    expect(pairs).toHaveLength(0);
    expect(unmatchedBefore).toHaveLength(1);
    expect(unmatchedAfter).toHaveLength(1);
  });

  it('Does not match untagged items across rooms on appearance alone', () => {
    const result = compareWalks({
      before: [line({ lineId: 'b', categoryId: 'chair', roomId: 'room-1', appearance: [1, 0] })],
      after: [line({ lineId: 'a', categoryId: 'chair', roomId: 'room-2', appearance: [1, 0] })],
      filmedRoomIds: ['room-1', 'room-2'],
    });
    expect(result.items.map((i) => i.status).sort()).toEqual(['new', 'not_seen']);
  });

  it('Gives identical results for identical input, whatever the input order (DMS-042)', () => {
    const before = [
      line({ lineId: 'b1', categoryId: 'desk', position: { x: 0.1, y: 0.1 } }),
      line({ lineId: 'b2', categoryId: 'desk', position: { x: 0.9, y: 0.9 } }),
    ];
    const after = [
      line({ lineId: 'a1', categoryId: 'desk', position: { x: 0.12, y: 0.1 } }),
      line({ lineId: 'a2', categoryId: 'desk', position: { x: 0.88, y: 0.9 } }),
    ];
    const one = compareWalks({ before, after, filmedRoomIds: ['room-1'] });
    const two = compareWalks({ before: [...before].reverse(), after: [...after].reverse(), filmedRoomIds: ['room-1'] });
    expect(two).toEqual(one);
  });
});

describe('DMS-073: counted groups compare quantities', () => {
  const chairs = (lineId: string, quantity: number): ComparableLine =>
    line({ lineId, categoryId: 'classroom_chair', kind: 'counted_group', quantity, roomId: 'class-3' });

  it('Given 32 chairs in walk 1 and 24 in walk 2, then the line shows minus 8 with both walks\' lines', () => {
    const result = compareWalks({ before: [chairs('w1', 32)], after: [chairs('w2', 24)], filmedRoomIds: ['class-3'] });
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item).toMatchObject({
      status: 'not_seen',
      quantityBefore: 32,
      quantityAfter: 24,
      quantityDelta: -8,
      beforeLineId: 'w1',
      afterLineId: 'w2',
    });
    expect(describeGroupQuantity(24, 32, 'chairs')).toBe('24 chairs, was 32');
    expect(describeQuantityDelta(item?.quantityDelta ?? 0)).toBe('minus 8');
  });

  it('More items than before is "new" with a positive difference', () => {
    const result = compareWalks({ before: [chairs('w1', 24)], after: [chairs('w2', 30)], filmedRoomIds: ['class-3'] });
    expect(result.items[0]).toMatchObject({ status: 'new', quantityDelta: 6 });
    expect(describeQuantityDelta(6)).toBe('plus 6');
  });

  it('The same count is unchanged', () => {
    const result = compareWalks({ before: [chairs('w1', 32)], after: [chairs('w2', 32)], filmedRoomIds: ['class-3'] });
    expect(result.items[0]).toMatchObject({ status: 'unchanged', quantityDelta: null });
  });

  it('A whole group in a room that was not filmed is "room not filmed"', () => {
    const result = compareWalks({ before: [chairs('w1', 32)], after: [], filmedRoomIds: [] });
    expect(result.items[0]?.status).toBe('room_not_filmed');
  });
});

describe('DMS-074: changes first, unchanged as one count', () => {
  it('Given 400 assets and 9 changes, then the 9 changes come first and the unchanged count is one number', () => {
    const before: ComparableLine[] = [];
    const after: ComparableLine[] = [];
    for (let i = 0; i < 400; i += 1) {
      const id = String(i).padStart(3, '0');
      before.push(line({ lineId: `b-${id}`, categoryId: 'desk', serial: `S${id}` }));
      if (i >= 9) after.push(line({ lineId: `a-${id}`, categoryId: 'desk', serial: `S${id}` }));
    }
    const result = compareWalks({ before, after, filmedRoomIds: ['room-1'] });
    expect(result.changeCount).toBe(9);
    expect(result.unchangedCount).toBe(391);
    expect(result.items.slice(0, 9).every((i) => i.status === 'not_seen')).toBe(true);
    expect(result.items.slice(9).every((i) => i.status === 'unchanged')).toBe(true);
  });

  it('Opens with the sentence "9 changes since the walk on 3 October"', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    expect(comparisonHeadline(9, new Date('2026-10-03T09:00:00Z'), now)).toBe('9 changes since the walk on 3 October');
    expect(comparisonHeadline(1, new Date('2026-10-03T09:00:00Z'), now)).toBe('1 change since the walk on 3 October');
    expect(comparisonHeadline(2, new Date('2025-10-03T09:00:00Z'), now)).toBe('2 changes since the walk on 3 October 2025');
  });

  it('Dates follow Lagos time, so a walk at 23:30 UTC on 2 October is 3 October', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    expect(comparisonHeadline(0, new Date('2026-10-02T23:30:00Z'), now)).toBe('0 changes since the walk on 3 October');
  });
});
