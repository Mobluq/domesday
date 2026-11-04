import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalReportText,
  correctionsFrom,
  crockfordBase32,
  formatVerificationCode,
  normaliseVerificationCode,
  reconcileWithRegister,
  verificationCodeFromDigest,
  type ReconcilableLine,
  type RegisterLine,
} from '../src';

const reg = (over: Partial<RegisterLine> & { registerId: string }): RegisterLine => ({
  description: 'Item',
  categoryId: 'other',
  siteId: 'ikeja',
  roomId: 'r204',
  locationLabel: 'Room 204',
  quantity: 1,
  bookValueKobo: 10_000_00,
  ...over,
});

const line = (over: Partial<ReconcilableLine> & { lineId: string }): ReconcilableLine => ({
  siteId: 'ikeja',
  roomId: 'r204',
  categoryId: 'other',
  description: 'Item',
  quantity: 1,
  ...over,
});

describe('reconcile with the register', () => {
  it('Matches by tag first, then serial, and calls a match in another room "found elsewhere"', () => {
    const r = reconcileWithRegister({
      register: [
        reg({ registerId: 'FA-0412', categoryId: 'projector', roomId: 'training', locationLabel: 'Training room', tagCode: 'FA-0412' }),
        reg({ registerId: 'FA-0450', categoryId: 'split-ac', roomId: 'r112', serial: '310KAP0X2181' }),
      ],
      lines: [
        line({ lineId: 'l1', categoryId: 'projector', roomId: 'boardroom', tagCode: 'fa 0412'.replace(' ', '-') }),
        line({ lineId: 'l2', categoryId: 'split-ac', roomId: 'r112', serial: '310kap0x2181' }),
      ],
      filmedRoomIds: ['boardroom', 'r112', 'training'],
    });
    const byReg = new Map(r.items.map((i) => [i.registerId, i]));
    expect(byReg.get('FA-0412')).toMatchObject({ status: 'found_elsewhere', method: 'tag', bookRoomId: 'training', seenRoomId: 'boardroom' });
    expect(byReg.get('FA-0450')).toMatchObject({ status: 'found', method: 'serial' });
    expect(correctionsFrom(r)).toEqual([{ kind: 'location_change', registerId: 'FA-0412', lineId: 'l1', fromRoomId: 'training', toRoomId: 'boardroom' }]);
  });

  it('Offers a description match with a score and reasons, and changes nothing until a person confirms it', () => {
    const input = {
      register: [reg({ registerId: 'FA-1078', categoryId: 'armchair', description: 'Armchair, cream fabric' })],
      lines: [line({ lineId: 'l9', categoryId: 'armchair', description: 'Upholstered armchair in cream fabric' })],
      filmedRoomIds: ['r204'],
      categoryName: (id: string) => (id === 'armchair' ? 'Armchair' : id),
      roomName: () => 'Room 204',
    };
    const before = reconcileWithRegister(input);
    expect(before.candidates).toHaveLength(1);
    expect(before.candidates[0]?.score).toBeGreaterThanOrEqual(80);
    expect(before.candidates[0]?.reasons).toContain('Same room: Room 204');
    expect(before.counts).toMatchObject({ found: 0, not_seen: 1, unrecorded: 1 });

    const after = reconcileWithRegister({ ...input, decisions: [{ registerId: 'FA-1078', lineId: 'l9', decision: 'confirmed' }] });
    expect(after.candidates).toHaveLength(0);
    expect(after.counts).toMatchObject({ found: 1, not_seen: 0, unrecorded: 0 });
    expect(after.items[0]?.method).toBe('description');

    const refused = reconcileWithRegister({ ...input, decisions: [{ registerId: 'FA-1078', lineId: 'l9', decision: 'rejected' }] });
    expect(refused.candidates).toHaveLength(0);
    expect(refused.counts).toMatchObject({ not_seen: 1, unrecorded: 1 });
  });

  it('Reports a counted group that came up short as found, plus the shortfall as not seen with its share of the value', () => {
    const r = reconcileWithRegister({
      register: [reg({ registerId: 'FA-0877', categoryId: 'stacking-chair', roomId: 'training', quantity: 32, bookValueKobo: 1_120_000_00 })],
      lines: [line({ lineId: 'l3', categoryId: 'stacking-chair', roomId: 'training', quantity: 24 })],
      filmedRoomIds: ['training'],
      decisions: [{ registerId: 'FA-0877', lineId: 'l3', decision: 'confirmed' }],
    });
    const notSeen = r.items.find((i) => i.status === 'not_seen');
    expect(notSeen).toMatchObject({ partOfGroup: true, notSeenQuantity: 8, valueKobo: 280_000_00 });
    expect(r.notSeenValueKobo).toBe(280_000_00);
    expect(r.counts.found).toBe(1);
  });

  it('Never calls a line in an unfilmed room "not seen"', () => {
    const r = reconcileWithRegister({
      register: [reg({ registerId: 'FA-0101', roomId: 'plant', bookValueKobo: 1_350_000_00 }), reg({ registerId: 'FA-0999', roomId: null })],
      lines: [],
      filmedRoomIds: ['r204'],
    });
    expect(r.items.map((i) => i.status)).toEqual(['room_not_filmed', 'room_not_filmed']);
    expect(r.roomNotFilmedValueKobo).toBe(1_360_000_00);
    expect(r.notSeenValueKobo).toBe(0);
  });

  it('Lists approved lines with no register line as unrecorded, each a new line in the corrections file', () => {
    const r = reconcileWithRegister({ register: [], lines: [line({ lineId: 'l7', categoryId: 'floor-lamp' })], filmedRoomIds: ['r204'] });
    expect(r.counts.unrecorded).toBe(1);
    expect(correctionsFrom(r)).toEqual([{ kind: 'new_line', lineId: 'l7', roomId: 'r204', quantity: 1 }]);
  });

  it('Refuses a description match when serials read on both sides disagree', () => {
    const r = reconcileWithRegister({
      register: [reg({ registerId: 'FA-1', categoryId: 'generator', serial: 'AAA111' })],
      lines: [line({ lineId: 'l1', categoryId: 'generator', serial: 'BBB222' })],
      filmedRoomIds: ['r204'],
    });
    expect(r.candidates).toHaveLength(0);
  });

  it('Gives the same answer whatever order the input arrives in', () => {
    const register = [reg({ registerId: 'B', categoryId: 'desk' }), reg({ registerId: 'A', categoryId: 'desk' })];
    const lines = [line({ lineId: 'y', categoryId: 'desk' }), line({ lineId: 'x', categoryId: 'desk' })];
    const one = reconcileWithRegister({ register, lines, filmedRoomIds: ['r204'] });
    const two = reconcileWithRegister({ register: [...register].reverse(), lines: [...lines].reverse(), filmedRoomIds: ['r204'] });
    expect(two).toEqual(one);
  });
});

describe('verification codes', () => {
  it('Writes the first 60 bits of the digest in Crockford base32, in groups of four', () => {
    const digest = createHash('sha256').update(canonicalReportText('Ikeja branch,   walk of\n4 November 2026')).digest();
    const code = verificationCodeFromDigest(new Uint8Array(digest));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    expect(formatVerificationCode(code)).toMatch(/^\w{4} \w{4} \w{4}$/);
    expect(crockfordBase32(new Uint8Array([0xff, 0xff]), 3)).toBe('ZZZ');
    expect(crockfordBase32(new Uint8Array([0x00, 0x00]), 3)).toBe('000');
  });

  it('Changes the code when one word of the report changes', () => {
    const a = createHash('sha256').update(canonicalReportText('8 lines not seen, ₦1,753,000')).digest();
    const b = createHash('sha256').update(canonicalReportText('8 lines not seen, ₦1,758,000')).digest();
    expect(verificationCodeFromDigest(new Uint8Array(a))).not.toBe(verificationCodeFromDigest(new Uint8Array(b)));
  });

  it('Reads a code as people type it, and refuses anything that cannot be one', () => {
    expect(normaliseVerificationCode('7f3a-k29q-oc4e')).toBe('7F3AK29Q0C4E');
    expect(normaliseVerificationCode('7F3A K29Q 0C4')).toBeNull();
    expect(normaliseVerificationCode('7F3A K29Q 0C4U')).toBeNull();
  });
});
