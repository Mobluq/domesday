import { normaliseIdentifier } from './compare-walks';
import type { Kobo } from './register';
import type { ReconMatchMethod } from '../vocabulary/work';

/** A line of the imported register, with its location already mapped to a room where possible (DMS-003, DMS-004). */
export interface RegisterLine {
  readonly registerId: string;
  readonly description: string;
  /** The tenant category the line was mapped to on import, or null when unmapped. */
  readonly categoryId: string | null;
  readonly siteId: string;
  /** The room the books put it in, or null when the register location maps to no room. */
  readonly roomId: string | null;
  /** The location exactly as the register writes it. */
  readonly locationLabel: string;
  readonly tagCode?: string | null;
  readonly serial?: string | null;
  /** 1 for a single item, otherwise the number of identical items the line covers. */
  readonly quantity: number;
  readonly bookValueKobo: Kobo | null;
}

/** An approved asset line as reconciliation needs to see it. */
export interface ReconcilableLine {
  readonly lineId: string;
  readonly siteId: string;
  readonly roomId: string;
  readonly categoryId: string;
  readonly description: string;
  readonly quantity: number;
  readonly tagCode?: string | null;
  readonly serial?: string | null;
}

/** A person's answer to a proposed description match (DMS-061: a human must confirm it). */
export interface MatchDecision {
  readonly registerId: string;
  readonly lineId: string;
  readonly decision: 'confirmed' | 'rejected';
}

/** A description-based match the reconciliation proposes and a person has not yet answered. */
export interface MatchCandidate {
  readonly registerId: string;
  readonly lineId: string;
  /** 0 to 100. */
  readonly score: number;
  readonly reasons: readonly string[];
}

export type ReconItemStatus = 'found' | 'found_elsewhere' | 'unrecorded' | 'not_seen' | 'room_not_filmed';

export interface ReconItem {
  readonly status: ReconItemStatus;
  readonly registerId: string | null;
  readonly lineId: string | null;
  readonly method: ReconMatchMethod | null;
  /** Score of a confirmed description match. */
  readonly score: number | null;
  readonly quantityInBooks: number | null;
  readonly quantitySeen: number | null;
  /** How many of the register line's items this row is about when it is not seen: all of them, or a group's shortfall. */
  readonly notSeenQuantity: number;
  /** True for the not-seen part of a counted group that was otherwise found ("8 of 32"). */
  readonly partOfGroup: boolean;
  /** Book value of the items this row says were not seen or are in a room not filmed, when the register has a value. */
  readonly valueKobo: Kobo | null;
  /** Where the books put it. */
  readonly bookRoomId: string | null;
  readonly bookSiteId: string | null;
  /** Where the walk saw it. */
  readonly seenRoomId: string | null;
  readonly seenSiteId: string | null;
}

export interface ReconcileInput {
  readonly register: readonly RegisterLine[];
  readonly lines: readonly ReconcilableLine[];
  /** Rooms with status filmed on the walk. A register line in any other room is "room not filmed", never "not seen". */
  readonly filmedRoomIds: Iterable<string>;
  readonly decisions?: readonly MatchDecision[];
  /** Lowest score offered as a description match. Category agreement alone scores 50. */
  readonly minCandidateScore?: number;
  /** Optional names for the reasons shown with a candidate. */
  readonly categoryName?: (categoryId: string) => string;
  readonly roomName?: (roomId: string) => string;
}

export interface ReconcileResult {
  readonly items: readonly ReconItem[];
  /** Description matches waiting for a person, best first. Their lines count as unrecorded and their register lines as not seen until confirmed. */
  readonly candidates: readonly MatchCandidate[];
  readonly counts: Readonly<Record<ReconItemStatus, number>>;
  readonly notSeenValueKobo: Kobo;
  readonly roomNotFilmedValueKobo: Kobo;
  /** Not-seen rows whose register line has no book value, so the total above leaves them out. */
  readonly notSeenWithoutValue: number;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'with', 'in', 'on', 'for', 'to', 'at', 'by', 'or', 'x']);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)),
  );
}

function sharedWords(a: string, b: string): string[] {
  const wa = words(a);
  return [...words(b)].filter((w) => wa.has(w)).sort();
}

function shareOf(total: Kobo | null, part: number, of: number): Kobo | null {
  if (total === null || of <= 0) return null;
  return Math.round((total * part) / of);
}

function byId<T>(key: (t: T) => string) {
  return (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/**
 * DMS-060 to DMS-062: match approved lines to the imported register.
 *
 * Tag number first, then serial number (exact, after normalising), then description
 * matches that a person has confirmed. Unconfirmed description matches are returned
 * as candidates with a score and reasons, and change nothing until confirmed.
 * Deterministic: the same input always gives the same result.
 */
export function reconcileWithRegister(input: ReconcileInput): ReconcileResult {
  const filmed = new Set(input.filmedRoomIds);
  const minScore = input.minCandidateScore ?? 50;
  const catName = input.categoryName ?? ((id: string) => id);
  const roomName = input.roomName ?? ((id: string) => id);

  const register = [...input.register].sort(byId((r) => r.registerId));
  const lines = [...input.lines].sort(byId((l) => l.lineId));
  const openRegister = new Map(register.map((r) => [r.registerId, r] as const));
  const openLines = new Map(lines.map((l) => [l.lineId, l] as const));
  const matches: { reg: RegisterLine; line: ReconcilableLine; method: ReconMatchMethod; score: number | null }[] = [];

  const take = (reg: RegisterLine, line: ReconcilableLine, method: ReconMatchMethod, score: number | null): void => {
    matches.push({ reg, line, method, score });
    openRegister.delete(reg.registerId);
    openLines.delete(line.lineId);
  };

  const exactPass = (method: ReconMatchMethod, key: (x: { tagCode?: string | null; serial?: string | null }) => string | null): void => {
    const index = new Map<string, RegisterLine>();
    for (const reg of openRegister.values()) {
      const k = key(reg);
      if (k !== null && !index.has(k)) index.set(k, reg);
    }
    for (const line of [...openLines.values()]) {
      const k = key(line);
      const reg = k === null ? undefined : index.get(k);
      if (reg && openRegister.has(reg.registerId)) take(reg, line, method, null);
    }
  };

  exactPass('tag', (x) => normaliseIdentifier(x.tagCode));
  exactPass('serial', (x) => normaliseIdentifier(x.serial));

  const scoreOf = (reg: RegisterLine, line: ReconcilableLine): MatchCandidate | null => {
    if (reg.categoryId === null || reg.categoryId !== line.categoryId) return null;
    // Identifiers read on both sides must not disagree.
    const regTag = normaliseIdentifier(reg.tagCode);
    const lineTag = normaliseIdentifier(line.tagCode);
    if (regTag !== null && lineTag !== null && regTag !== lineTag) return null;
    const regSerial = normaliseIdentifier(reg.serial);
    const lineSerial = normaliseIdentifier(line.serial);
    if (regSerial !== null && lineSerial !== null && regSerial !== lineSerial) return null;

    const reasons = [`Same category: ${catName(line.categoryId)}`];
    let score = 50;
    if (reg.siteId === line.siteId && reg.roomId !== null && reg.roomId === line.roomId) {
      score += 30;
      reasons.push(`Same room: ${roomName(line.roomId)}`);
    } else if (reg.roomId !== null) {
      reasons.push(`Books say ${reg.locationLabel}, seen in ${roomName(line.roomId)}`);
    }
    const shared = sharedWords(reg.description, line.description);
    const union = new Set([...words(reg.description), ...words(line.description)]).size;
    if (shared.length > 0 && union > 0) {
      score += Math.round((15 * shared.length) / union);
      reasons.push(`Description shares: ${shared.join(', ')}`);
    }
    if (reg.quantity > 1 || line.quantity > 1) {
      const ratio = Math.min(reg.quantity, line.quantity) / Math.max(reg.quantity, line.quantity);
      score += Math.round(5 * ratio);
      reasons.push(`Quantity: ${line.quantity} seen, ${reg.quantity} in the books`);
    } else {
      score += 5;
    }
    return { registerId: reg.registerId, lineId: line.lineId, score: Math.min(100, score), reasons };
  };

  const decisions = input.decisions ?? [];
  const rejected = new Set(decisions.filter((d) => d.decision === 'rejected').map((d) => `${d.registerId}|${d.lineId}`));
  for (const d of [...decisions].filter((x) => x.decision === 'confirmed').sort(byId((x) => `${x.registerId}|${x.lineId}`))) {
    const reg = openRegister.get(d.registerId);
    const line = openLines.get(d.lineId);
    if (!reg || !line) continue;
    const scored = scoreOf(reg, line);
    take(reg, line, 'description', scored?.score ?? null);
  }

  const all: MatchCandidate[] = [];
  for (const reg of openRegister.values()) {
    for (const line of openLines.values()) {
      if (rejected.has(`${reg.registerId}|${line.lineId}`)) continue;
      const c = scoreOf(reg, line);
      if (c && c.score >= minScore) all.push(c);
    }
  }
  all.sort((a, b) => b.score - a.score || (a.registerId < b.registerId ? -1 : a.registerId > b.registerId ? 1 : a.lineId < b.lineId ? -1 : 1));
  const usedReg = new Set<string>();
  const usedLine = new Set<string>();
  const candidates: MatchCandidate[] = [];
  for (const c of all) {
    if (usedReg.has(c.registerId) || usedLine.has(c.lineId)) continue;
    usedReg.add(c.registerId);
    usedLine.add(c.lineId);
    candidates.push(c);
  }

  const items: ReconItem[] = [];
  for (const { reg, line, method, score } of matches) {
    const samePlace = reg.siteId === line.siteId && reg.roomId === line.roomId;
    items.push({
      status: samePlace ? 'found' : 'found_elsewhere',
      registerId: reg.registerId,
      lineId: line.lineId,
      method,
      score,
      quantityInBooks: reg.quantity,
      quantitySeen: line.quantity,
      notSeenQuantity: 0,
      partOfGroup: false,
      valueKobo: null,
      bookRoomId: reg.roomId,
      bookSiteId: reg.siteId,
      seenRoomId: line.roomId,
      seenSiteId: line.siteId,
    });
    const shortfall = reg.quantity - line.quantity;
    if (shortfall > 0) {
      items.push({
        status: 'not_seen',
        registerId: reg.registerId,
        lineId: line.lineId,
        method,
        score,
        quantityInBooks: reg.quantity,
        quantitySeen: line.quantity,
        notSeenQuantity: shortfall,
        partOfGroup: true,
        valueKobo: shareOf(reg.bookValueKobo, shortfall, reg.quantity),
        bookRoomId: reg.roomId,
        bookSiteId: reg.siteId,
        seenRoomId: line.roomId,
        seenSiteId: line.siteId,
      });
    }
  }
  for (const reg of openRegister.values()) {
    const roomFilmed = reg.roomId !== null && filmed.has(reg.roomId);
    items.push({
      status: roomFilmed ? 'not_seen' : 'room_not_filmed',
      registerId: reg.registerId,
      lineId: null,
      method: null,
      score: null,
      quantityInBooks: reg.quantity,
      quantitySeen: null,
      notSeenQuantity: roomFilmed ? reg.quantity : 0,
      partOfGroup: false,
      valueKobo: reg.bookValueKobo,
      bookRoomId: reg.roomId,
      bookSiteId: reg.siteId,
      seenRoomId: null,
      seenSiteId: null,
    });
  }
  for (const line of openLines.values()) {
    items.push({
      status: 'unrecorded',
      registerId: null,
      lineId: line.lineId,
      method: null,
      score: null,
      quantityInBooks: null,
      quantitySeen: line.quantity,
      notSeenQuantity: 0,
      partOfGroup: false,
      valueKobo: null,
      bookRoomId: null,
      bookSiteId: null,
      seenRoomId: line.roomId,
      seenSiteId: line.siteId,
    });
  }

  const order: ReconItemStatus[] = ['not_seen', 'found_elsewhere', 'unrecorded', 'room_not_filmed', 'found'];
  items.sort(
    (a, b) =>
      order.indexOf(a.status) - order.indexOf(b.status) ||
      (b.valueKobo ?? -1) - (a.valueKobo ?? -1) ||
      `${a.registerId ?? ''}|${a.lineId ?? ''}`.localeCompare(`${b.registerId ?? ''}|${b.lineId ?? ''}`),
  );

  const counts: Record<ReconItemStatus, number> = { found: 0, found_elsewhere: 0, unrecorded: 0, not_seen: 0, room_not_filmed: 0 };
  let notSeenValueKobo = 0;
  let roomNotFilmedValueKobo = 0;
  let notSeenWithoutValue = 0;
  for (const item of items) {
    counts[item.status] += 1;
    if (item.status === 'not_seen') {
      if (item.valueKobo === null) notSeenWithoutValue += 1;
      else notSeenValueKobo += item.valueKobo;
    }
    if (item.status === 'room_not_filmed' && item.valueKobo !== null) roomNotFilmedValueKobo += item.valueKobo;
  }

  return { items, candidates, counts, notSeenValueKobo, roomNotFilmedValueKobo, notSeenWithoutValue };
}

export type CorrectionRow =
  | { readonly kind: 'new_line'; readonly lineId: string; readonly roomId: string; readonly quantity: number }
  | {
      readonly kind: 'location_change';
      readonly registerId: string;
      readonly lineId: string;
      readonly fromRoomId: string | null;
      readonly toRoomId: string;
    };

/**
 * DMS-064: the corrections the controller can export: new lines to add and locations
 * to change. Nothing is proposed for write-off until an investigation records an outcome.
 */
export function correctionsFrom(result: ReconcileResult): CorrectionRow[] {
  const rows: CorrectionRow[] = [];
  for (const item of result.items) {
    if (item.status === 'unrecorded' && item.lineId !== null && item.seenRoomId !== null) {
      rows.push({ kind: 'new_line', lineId: item.lineId, roomId: item.seenRoomId, quantity: item.quantitySeen ?? 1 });
    }
    if (item.status === 'found_elsewhere' && item.registerId !== null && item.lineId !== null && item.seenRoomId !== null) {
      rows.push({ kind: 'location_change', registerId: item.registerId, lineId: item.lineId, fromRoomId: item.bookRoomId, toRoomId: item.seenRoomId });
    }
  }
  return rows;
}
