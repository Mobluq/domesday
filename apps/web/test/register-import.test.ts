import { describe, expect, it } from 'vitest';
import { assignRooms, importRegister, mapColumns, matchCategory, matchRoom, parseCsv, parseDate, parseNaira, REGISTER_TEMPLATE, roomsFromLocations } from '../src/data/register-import';
import type { Category, RoomDef } from '../src/data/types';

const categories: Category[] = [
  { id: 'desk', name: 'Desk', plural: 'desks' },
  { id: 'student-desk', name: 'Student or training desk', plural: 'student desks' },
  { id: 'office-chair', name: 'Office chair', plural: 'office chairs' },
  { id: 'stacking-chair', name: 'Stacking or training chair', plural: 'chairs' },
  { id: 'television', name: 'Television', plural: 'televisions' },
  { id: 'split-ac', name: 'Split air conditioner', plural: 'air conditioners' },
  { id: 'solar-battery', name: 'Solar battery', plural: 'solar batteries' },
  { id: 'laptop', name: 'Laptop', plural: 'laptops' },
  { id: 'fire-extinguisher', name: 'Fire extinguisher', plural: 'fire extinguishers' },
  { id: 'other', name: 'Other asset', plural: 'other assets' },
];
const rooms: RoomDef[] = [
  { id: 'r-204', name: 'Room 204', floor: 'Floor 2' },
  { id: 'boardroom', name: 'Boardroom', floor: 'Floor 1' },
  { id: 'store-b', name: 'Store room B', floor: 'Floor 2' },
];

describe('reading a fixed asset register', () => {
  it('Parses quoted CSV with commas, doubled quotes, CRLF and a byte order mark', () => {
    const rows = parseCsv('\uFEFFAsset ID,Description\r\nFA-1,"Chair, ""mesh"""\r\n\r\nFA-2,Desk\r\n');
    expect(rows).toEqual([
      ['Asset ID', 'Description'],
      ['FA-1', 'Chair, "mesh"'],
      ['FA-2', 'Desk'],
    ]);
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('Finds columns by meaning, whatever the books call them', () => {
    const m = mapColumns(['FA No', 'Asset Description', 'Asset Class', 'Room', 'Qty', 'Cost (NGN)', 'NBV', 'Date Acquired', 'Barcode', 'S/N']);
    expect(m).toEqual({ registerId: 0, description: 1, category: 2, location: 3, quantity: 4, cost: 5, bookValue: 6, acquired: 7, tagCode: 8, serial: 9 });
  });

  it('Reads naira and Nigerian dates', () => {
    expect(parseNaira('₦450,000.00')).toBe(45_000_000);
    expect(parseNaira('NGN 1,200,000')).toBe(120_000_000);
    expect(parseNaira('N45,000')).toBe(4_500_000);
    expect(parseNaira('(1,000)')).toBe(-100_000);
    expect(parseNaira('-')).toBeNull();
    expect(parseDate('12/04/2023')).toBe('2023-04-12');
    expect(parseDate('04/25/2023')).toBe('2023-04-25');
    expect(parseDate('12-Apr-2023')).toBe('2023-04-12');
    expect(parseDate('2023-04-12')).toBe('2023-04-12');
    expect(parseDate('45028')).toBe('2023-04-12');
    expect(parseDate('31/02/2023')).toBeNull();
  });

  it('Matches categories by the most specific name', () => {
    expect(matchCategory('Student desks (16)', categories)).toBe('student-desk');
    expect(matchCategory('Executive desk', categories)).toBe('desk');
    expect(matchCategory('Training chairs (32)', categories)).toBe('stacking-chair');
    expect(matchCategory('Office chairs, mesh (2)', categories)).toBe('office-chair');
    expect(matchCategory('Solar batteries, 200 Ah (4)', categories)).toBe('solar-battery');
    expect(matchCategory('Samsung 55" TV', categories)).toBe('television');
    expect(matchCategory('Furniture and fittings', categories)).toBeNull();
  });

  it('Matches register locations to rooms', () => {
    expect(matchRoom('Rm 204', rooms)).toBe('r-204');
    expect(matchRoom('2nd floor, Room 204', rooms)).toBe('r-204');
    expect(matchRoom('Boardroom (1st floor)', rooms)).toBe('boardroom');
    expect(matchRoom('Kitchen', rooms)).toBeNull();
  });

  it('Imports the template and lists locations that are not rooms yet', () => {
    const r = importRegister(REGISTER_TEMPLATE, { categories, rooms });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(4);
    expect(r.value.entries[0]).toMatchObject({ registerId: 'FA-0001', categoryId: 'split-ac', roomId: 'boardroom', costKobo: 45_000_000, acquired: '2023-04-12', tagCode: 'FA-0001' });
    expect(r.value.entries[1]).toMatchObject({ quantity: 8, categoryId: 'office-chair' });
    expect(r.value.newLocations.map((l) => l.label)).toEqual(['Corridor 2', 'Room 112']);
    const made = roomsFromLocations(['Room 112', 'Boardroom'], rooms);
    expect(made.map((x) => x.id)).toEqual(['room-112', 'boardroom-2']);
    const again = assignRooms(r.value.entries, [...rooms, ...made]);
    expect(again[2]?.roomId).toBe('room-112');
  });

  it('Skips titles above the header and total rows, and keeps repeated IDs apart', () => {
    const csv = ['Fixed asset register,,', 'As at 30 September 2026,,', 'Asset ID,Description,Cost', 'FA-1,Desk,"10,000"', 'FA-1,Desk,"10,000"', ',Total,"20,000"'].join('\n');
    const r = importRegister(csv, { categories, rooms });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries.map((e) => e.registerId)).toEqual(['FA-1', 'FA-1-2']);
    expect(r.value.totalCostKobo).toBe(2_000_000);
    expect(r.value.warnings.join(' ')).toContain('more than once');
  });

  it('Says plainly what is wrong with a file it cannot read', () => {
    const r = importRegister('just one line', { categories, rooms });
    expect(r.ok).toBe(false);
    const r2 = importRegister('Cost,Value\n1,2\n', { categories, rooms });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('header');
  });
});
