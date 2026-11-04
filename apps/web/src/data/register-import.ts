import type { Category, RegisterEntry, RoomDef } from './types';

/**
 * Reads a fixed asset register exported from the books (CSV from Excel, Sage, QuickBooks or an
 * ERP) into register lines. Column names vary from firm to firm, so headers are matched by meaning;
 * values are read the way Nigerian registers write them: naira with commas, dates day first.
 */

export type RegisterField = 'registerId' | 'description' | 'category' | 'location' | 'quantity' | 'cost' | 'bookValue' | 'acquired' | 'tagCode' | 'serial';

export const FIELD_LABEL: Readonly<Record<RegisterField, string>> = {
  registerId: 'Asset ID',
  description: 'Description',
  category: 'Category',
  location: 'Location',
  quantity: 'Quantity',
  cost: 'Cost',
  bookValue: 'Net book value',
  acquired: 'Acquired',
  tagCode: 'Tag code',
  serial: 'Serial number',
};

const ALIASES: Readonly<Record<RegisterField, readonly string[]>> = {
  registerId: ['asset id', 'asset number', 'asset no', 'asset code', 'asset ref', 'register id', 'fa number', 'fa no', 'fixed asset number', 'fixed asset no', 'id', 'code', 'reference', 'ref'],
  description: ['description', 'asset description', 'asset name', 'name', 'item', 'item description', 'details'],
  category: ['category', 'asset category', 'class', 'asset class', 'type', 'asset type', 'group', 'asset group'],
  location: ['location', 'room', 'area', 'room or area', 'site location', 'office', 'where'],
  quantity: ['quantity', 'qty', 'count', 'units', 'no of units', 'number of units', 'number'],
  cost: ['cost', 'purchase cost', 'acquisition cost', 'original cost', 'historical cost', 'cost price', 'gross cost', 'purchase price', 'amount'],
  bookValue: ['net book value', 'nbv', 'book value', 'carrying amount', 'carrying value', 'written down value', 'wdv'],
  acquired: ['acquired', 'date acquired', 'acquisition date', 'purchase date', 'date of purchase', 'date purchased', 'in service date', 'capitalisation date', 'capitalization date'],
  tagCode: ['tag code', 'tag', 'asset tag', 'barcode', 'bar code', 'label', 'tag number', 'tag no'],
  serial: ['serial', 'serial number', 'serial no', 's n', 'sn', 'serial num'],
};

const ORDER: readonly RegisterField[] = ['registerId', 'description', 'category', 'location', 'quantity', 'cost', 'bookValue', 'acquired', 'tagCode', 'serial'];

/** RFC 4180 CSV, plus the semicolon and tab files some spreadsheets save. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const first = s.split(/\r?\n/, 1)[0] ?? '';
  const delim = ([',', ';', '\t'] as const).map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ''));
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\((ngn|naira|₦|n)\)|₦|ngn/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Which column holds which field. Exact names win over partial ones; a column is used once. */
export function mapColumns(header: readonly string[]): Partial<Record<RegisterField, number>> {
  const cols = header.map(norm);
  const map: Partial<Record<RegisterField, number>> = {};
  const taken = new Set<number>();
  for (const pass of ['exact', 'partial'] as const) {
    for (const f of ORDER) {
      if (map[f] !== undefined) continue;
      const i = cols.findIndex((c, idx) => {
        if (taken.has(idx) || !c) return false;
        return ALIASES[f].some((a) => (pass === 'exact' ? c === a : a.length > 3 && (c.startsWith(`${a} `) || c.endsWith(` ${a}`) || c.includes(` ${a} `))));
      });
      if (i >= 0) {
        map[f] = i;
        taken.add(i);
      }
    }
  }
  return map;
}

/** Naira in, kobo out. Accepts "₦450,000.00", "NGN 450000", "N450,000", "(1,000)". */
export function parseNaira(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.replace(/NGN|₦|,|\s/gi, '').replace(/^N(?=[\d(])/i, '');
  if (!t || t === '-' || t === '—') return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  const n = Number(t.replace(/[()-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += y < 50 ? 2000 : 1900;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Dates as registers write them. Numeric dates are read day first, as in Nigeria, unless that is impossible. */
export function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    return b > 12 && a <= 12 ? iso(y, a, b) : iso(y, b, a);
  }
  m = /^(\d{1,2})[\s/-]([a-z]{3,9})[\s/,-]+(\d{2,4})$/i.exec(t);
  if (m) {
    const mi = MONTHS.indexOf((m[2] as string).slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(Number(m[3]), mi + 1, Number(m[1]));
  }
  m = /^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/i.exec(t);
  if (m) {
    const mi = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase());
    if (mi >= 0) return iso(Number(m[3]), mi + 1, Number(m[2]));
  }
  // An Excel date serial that lost its formatting on export.
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const n = Math.floor(Number(t));
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  return null;
}

const STOP = new Set(['or', 'and', 'the', 'of', 'a', 'an', 'with', 'for', 'in', 'on', 'x']);

/** Words registers use for things the categories name differently. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  tv: ['television'],
  telly: ['television'],
  ac: ['air', 'conditioner'],
  aircon: ['air', 'conditioner'],
  fridge: ['refrigerator'],
  freezer: ['refrigerator'],
  pc: ['desktop', 'computer'],
  cpu: ['desktop', 'computer'],
  photocopier: ['printer'],
  copier: ['printer'],
  ups: ['inverter'],
  couch: ['sofa'],
  settee: ['sofa'],
  extinguisher: ['fire'],
};

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

/**
 * The site category a register's wording names, or null when none fits well enough. A category
 * qualifies when at least half the words of its name appear; the one with the most words present
 * wins, so "Student desks" is a student desk rather than a desk.
 */
export function matchCategory(text: string, categories: readonly Category[]): string | null {
  const t = norm(text);
  if (!t) return null;
  for (const c of categories) if (t === norm(c.id) || t === norm(c.name) || t === norm(c.plural)) return c.id;
  const have = new Set(tokens(text).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]));
  let best: { id: string; hits: number; frac: number; len: number } | null = null;
  for (const c of categories) {
    if (c.id === 'other') continue;
    const named = [...new Set(tokens(c.name))];
    if (!named.length) continue;
    const want = [...new Set([...named, ...tokens(c.plural)])];
    const hits = want.filter((w) => have.has(w)).length;
    const frac = Math.min(1, hits / named.length);
    if (frac < 0.5) continue;
    if (!best || hits > best.hits || (hits === best.hits && (frac > best.frac || (frac === best.frac && named.length < best.len)))) best = { id: c.id, hits, frac, len: named.length };
  }
  return best?.id ?? null;
}

function roomKey(s: string): string {
  return norm(s).replace(/\brm\b/g, 'room').replace(/\s+/g, ' ');
}

/** The site room a register location names, or null. */
export function matchRoom(text: string, rooms: readonly RoomDef[]): string | null {
  const t = roomKey(text);
  if (!t) return null;
  const exact = rooms.find((r) => roomKey(r.name) === t || r.id === t);
  if (exact) return exact.id;
  const contained = rooms.filter((r) => roomKey(r.name).length > 3 && ` ${t} `.includes(` ${roomKey(r.name)} `)).sort((a, b) => b.name.length - a.name.length);
  if (contained[0]) return contained[0].id;
  const num = /\b(\d{2,4}[a-z]?)\b/.exec(t)?.[1];
  if (num) {
    const byNum = rooms.filter((r) => new RegExp(`\\b${num}\\b`).test(roomKey(r.name)));
    if (byNum.length === 1 && byNum[0]) return byNum[0].id;
  }
  return null;
}

export interface RegisterImport {
  readonly entries: RegisterEntry[];
  /** The header each field was read from. */
  readonly columns: Partial<Record<RegisterField, string>>;
  readonly warnings: string[];
  /** Locations that are not rooms of the site yet, with how many lines each holds. */
  readonly newLocations: { readonly label: string; readonly lines: number }[];
  readonly totalCostKobo: number;
  readonly rowsRead: number;
}

export type ImportResult = { readonly ok: true; readonly value: RegisterImport } | { readonly ok: false; readonly message: string };

export function importRegister(text: string, site: { readonly categories: readonly Category[]; readonly rooms: readonly RoomDef[] }): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, message: 'The file has no rows under its header. Export the register as CSV with one asset per row.' };
  // The header is the first row that names a description or an asset ID; titles above it are skipped.
  let headerAt = rows.findIndex((r) => {
    const m = mapColumns(r);
    return m.description !== undefined || m.registerId !== undefined;
  });
  if (headerAt < 0 || headerAt > 10) headerAt = -1;
  if (headerAt < 0) return { ok: false, message: "We couldn't find the header row. The register needs a column called Description (and ideally Asset ID, Location and Cost)." };
  const header = rows[headerAt] as string[];
  const map = mapColumns(header);
  if (map.description === undefined) return { ok: false, message: "We couldn't find a description column. Name the column that says what each asset is Description." };
  const columns: Partial<Record<RegisterField, string>> = {};
  for (const f of ORDER) if (map[f] !== undefined) columns[f] = header[map[f] as number];

  const warnings: string[] = [];
  const entries: RegisterEntry[] = [];
  const seen = new Map<string, number>();
  const unknownLocations = new Map<string, number>();
  let badMoney = 0;
  let badDates = 0;
  let total = 0;
  const cell = (r: string[], f: RegisterField): string => (map[f] === undefined ? '' : (r[map[f] as number] ?? '').trim());

  rows.slice(headerAt + 1).forEach((r, i) => {
    const description = cell(r, 'description');
    let id = cell(r, 'registerId') || cell(r, 'tagCode');
    if (!description && !id) return;
    if (!id && /^(sub)?total\b/i.test(description)) return;
    if (!description) {
      warnings.push(`Row ${headerAt + i + 2} (${id}) has no description, so it was left out.`);
      return;
    }
    if (!id) id = `ROW-${String(i + 1).padStart(4, '0')}`;
    const dup = seen.get(id) ?? 0;
    seen.set(id, dup + 1);
    if (dup) {
      warnings.push(`Asset ID ${id} appears more than once; the repeat was kept as ${id}-${dup + 1}.`);
      id = `${id}-${dup + 1}`;
    }
    const qtyRaw = cell(r, 'quantity');
    const qty = qtyRaw ? Math.round(Number(qtyRaw.replace(/,/g, ''))) : 1;
    const costRaw = cell(r, 'cost');
    const bookRaw = cell(r, 'bookValue');
    const cost = parseNaira(costRaw);
    const book = parseNaira(bookRaw);
    if ((costRaw && cost === null) || (bookRaw && book === null)) badMoney++;
    const acqRaw = cell(r, 'acquired');
    const acquired = parseDate(acqRaw);
    if (acqRaw && !acquired) badDates++;
    const location = cell(r, 'location');
    const roomId = location ? matchRoom(location, site.rooms) : null;
    if (location && !roomId) unknownLocations.set(location, (unknownLocations.get(location) ?? 0) + 1);
    const catText = cell(r, 'category');
    const categoryId = (catText ? matchCategory(catText, site.categories) : null) ?? matchCategory(description, site.categories) ?? (catText ? 'other' : null);
    if (cost) total += cost;
    entries.push({
      registerId: id,
      description,
      categoryId,
      roomId,
      locationLabel: location || 'No location in the register',
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      costKobo: cost,
      bookValueKobo: book,
      acquired,
      tagCode: cell(r, 'tagCode') || null,
      serial: cell(r, 'serial') || null,
    });
  });

  if (!entries.length) return { ok: false, message: 'No asset rows were found under the header.' };
  if (map.location === undefined) warnings.push('There is no location column, so register lines are matched to what was filmed by description, tag and serial only.');
  if (badMoney) warnings.push(`${badMoney} ${badMoney === 1 ? 'value was' : 'values were'} not a number and ${badMoney === 1 ? 'was' : 'were'} left blank.`);
  if (badDates) warnings.push(`${badDates} acquisition ${badDates === 1 ? 'date was' : 'dates were'} not readable and ${badDates === 1 ? 'was' : 'were'} left blank.`);
  const noCategory = entries.filter((e) => !e.categoryId).length;
  if (noCategory) warnings.push(`${noCategory} ${noCategory === 1 ? 'line has' : 'lines have'} no category we recognise; they are matched by tag, serial and wording.`);

  return {
    ok: true,
    value: {
      entries,
      columns,
      warnings,
      newLocations: [...unknownLocations.entries()].map(([label, lines]) => ({ label, lines })).sort((a, b) => b.lines - a.lines || a.label.localeCompare(b.label)),
      totalCostKobo: total,
      rowsRead: entries.length,
    },
  };
}

/** Rooms made from register locations that are not rooms yet. Ids stay unique against the site's. */
export function roomsFromLocations(labels: readonly string[], existing: readonly RoomDef[]): RoomDef[] {
  const ids = new Set(existing.map((r) => r.id));
  const out: RoomDef[] = [];
  for (const label of labels) {
    const name = label.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'room';
    let id = base;
    let n = 2;
    while (ids.has(id)) id = `${base}-${n++}`;
    ids.add(id);
    out.push({ id, name, floor: 'Floor not set', note: 'From the register', sample: null });
  }
  return out;
}

/** Point register lines at rooms again, after rooms were added. */
export function assignRooms(entries: readonly RegisterEntry[], rooms: readonly RoomDef[]): RegisterEntry[] {
  return entries.map((e) => (e.roomId || e.locationLabel === 'No location in the register' ? e : { ...e, roomId: matchRoom(e.locationLabel, rooms) }));
}

export const REGISTER_TEMPLATE = [
  'Asset ID,Description,Category,Location,Quantity,Cost (NGN),Net book value (NGN),Acquired,Tag code,Serial number',
  'FA-0001,"Split air conditioner, 1.5 HP",Split air conditioner,Boardroom,1,"450,000","380,000",12/04/2023,FA-0001,',
  'FA-0002,"Office chairs, mesh",Office chair,Boardroom,8,"640,000","480,000",03/01/2022,,',
  'FA-0003,"Laptop, 14-inch",Laptop,Room 112,1,"1,200,000","800,000",15/08/2024,FA-0003,5CD1234XYZ',
  'FA-0004,"Fire extinguisher, 9 kg",Fire extinguisher,Corridor 2,1,"45,000","30,000",20/09/2023,,',
  '',
].join('\r\n');
