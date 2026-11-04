import {
  CHANGE_DISPLAY_ORDER,
  COUNTED_AS_CHANGE,
  ChangeStatus,
  conditionSeverity,
  type ConditionGrade,
} from '../vocabulary/statuses';
import type { ComparisonMatchMethod, LineKind } from '../vocabulary/work';

/** A rough position inside the room, each axis from 0 to 1. */
export interface PositionInRoom {
  readonly x: number;
  readonly y: number;
}

/** An approved asset line as the comparison needs to see it. */
export interface ComparableLine {
  readonly lineId: string;
  /** The confirmed asset this line belongs to, when processing or review has linked it. */
  readonly assetId?: string | null;
  readonly siteId: string;
  readonly roomId: string;
  readonly categoryId: string;
  readonly kind: LineKind;
  /** 1 for a single item; the count for a counted group (DMS-035). */
  readonly quantity: number;
  readonly condition: ConditionGrade;
  readonly tagCode?: string | null;
  readonly serial?: string | null;
  /** Appearance embedding from the recogniser. Lines from different models are never compared. */
  readonly appearance?: readonly number[] | null;
  readonly position?: PositionInRoom | null;
}

export interface MatchSettings {
  /** Lowest cosine similarity accepted as the same item. A placeholder until calibrated on the seeded comparison set (DMS-077). */
  readonly minAppearanceSimilarity: number;
  /** Largest distance (share of the room's size) accepted for a match on position alone. A placeholder, as above. */
  readonly maxPositionDistance: number;
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = Object.freeze({
  minAppearanceSimilarity: 0.85,
  maxPositionDistance: 0.25,
});

export interface LinePair {
  readonly before: ComparableLine;
  readonly after: ComparableLine;
  readonly method: ComparisonMatchMethod;
}

export interface WalkMatchResult {
  readonly pairs: readonly LinePair[];
  readonly unmatchedBefore: readonly ComparableLine[];
  readonly unmatchedAfter: readonly ComparableLine[];
}

export interface PlaceRef {
  readonly siteId: string;
  readonly roomId: string;
}

/** One row of a comparison (the ChangeItem entity in Part 6). */
export interface WalkChange {
  readonly status: ChangeStatus;
  readonly assetId: string | null;
  readonly beforeLineId: string | null;
  readonly afterLineId: string | null;
  readonly matchedBy: ComparisonMatchMethod | null;
  readonly quantityBefore: number | null;
  readonly quantityAfter: number | null;
  /** DMS-073: "24 chairs, was 32" gives -8. */
  readonly quantityDelta: number | null;
  /** A condition change on an item whose main status is something else, such as moved. */
  readonly conditionChange: 'worse' | 'better' | null;
  readonly from: PlaceRef | null;
  readonly to: PlaceRef | null;
}

/** Trim, upper-case and remove spaces so "sn 123-a" and "SN123-A" compare equal. */
export function normaliseIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalised = value.trim().toUpperCase().replace(/\s+/g, '');
  return normalised.length > 0 ? normalised : null;
}

/** Cosine similarity, or null when the vectors cannot be compared (different lengths or zero length). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / Math.sqrt(normA * normB);
}

function distance(a: PositionInRoom, b: PositionInRoom): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function byLineId(a: ComparableLine, b: ComparableLine): number {
  return a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0;
}

function conflicts(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a !== b;
}

interface Candidate {
  readonly before: ComparableLine;
  readonly after: ComparableLine;
  readonly similarity: number | null;
  readonly distance: number | null;
}

/**
 * DMS-072: match lines across two walks. Confirmed asset identity first, then tag
 * number (DMS-034), then serial number, then category, appearance and position in
 * the same room. Deterministic: the same input always gives the same pairs (DMS-042).
 */
export function matchLinesAcrossWalks(
  before: readonly ComparableLine[],
  after: readonly ComparableLine[],
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
): WalkMatchResult {
  const remainingBefore = new Map([...before].sort(byLineId).map((l) => [l.lineId, l] as const));
  const remainingAfter = new Map([...after].sort(byLineId).map((l) => [l.lineId, l] as const));
  const pairs: LinePair[] = [];

  const take = (b: ComparableLine, a: ComparableLine, method: ComparisonMatchMethod): void => {
    pairs.push({ before: b, after: a, method });
    remainingBefore.delete(b.lineId);
    remainingAfter.delete(a.lineId);
  };

  const exactPass = (method: ComparisonMatchMethod, keyOf: (l: ComparableLine) => string | null): void => {
    const index = new Map<string, ComparableLine[]>();
    for (const b of remainingBefore.values()) {
      const key = keyOf(b);
      if (key === null) continue;
      const list = index.get(key) ?? [];
      list.push(b);
      index.set(key, list);
    }
    for (const a of [...remainingAfter.values()]) {
      const key = keyOf(a);
      if (key === null) continue;
      const match = index.get(key)?.find((b) => remainingBefore.has(b.lineId));
      if (match) take(match, a, method);
    }
  };

  exactPass('asset_identity', (l) => l.assetId ?? null);
  exactPass('tag', (l) => normaliseIdentifier(l.tagCode));
  exactPass('serial', (l) => normaliseIdentifier(l.serial));

  // Category, appearance and position, only within the same room and only between
  // lines of the same kind. Identifiers that were read on both walks must not conflict.
  const groupKey = (l: ComparableLine): string => `${l.siteId}|${l.roomId}|${l.categoryId}|${l.kind}`;
  const groupSizes = (lines: Iterable<ComparableLine>): Map<string, number> => {
    const sizes = new Map<string, number>();
    for (const l of lines) sizes.set(groupKey(l), (sizes.get(groupKey(l)) ?? 0) + 1);
    return sizes;
  };
  const beforeGroups = groupSizes(remainingBefore.values());
  const afterGroups = groupSizes(remainingAfter.values());

  const candidates: Candidate[] = [];
  for (const b of remainingBefore.values()) {
    for (const a of remainingAfter.values()) {
      if (groupKey(a) !== groupKey(b)) continue;
      if (conflicts(normaliseIdentifier(a.tagCode), normaliseIdentifier(b.tagCode))) continue;
      if (conflicts(normaliseIdentifier(a.serial), normaliseIdentifier(b.serial))) continue;
      const similarity = a.appearance && b.appearance ? cosineSimilarity(a.appearance, b.appearance) : null;
      const apart = a.position && b.position ? distance(a.position, b.position) : null;
      if (similarity !== null) {
        if (similarity < settings.minAppearanceSimilarity) continue;
      } else if (apart !== null) {
        if (apart > settings.maxPositionDistance) continue;
      } else {
        // No appearance or position evidence: accept only the one obvious pairing, such
        // as the single group of chairs in a classroom on both walks (DMS-035, DMS-073).
        const key = groupKey(b);
        if (beforeGroups.get(key) !== 1 || afterGroups.get(key) !== 1) continue;
      }
      candidates.push({ before: b, after: a, similarity, distance: apart });
    }
  }

  candidates.sort((x, y) => {
    const xs = x.similarity ?? -1;
    const ys = y.similarity ?? -1;
    if (xs !== ys) return ys - xs;
    const xd = x.distance ?? Number.POSITIVE_INFINITY;
    const yd = y.distance ?? Number.POSITIVE_INFINITY;
    if (xd !== yd) return xd - yd;
    return byLineId(x.before, y.before) || byLineId(x.after, y.after);
  });
  for (const c of candidates) {
    if (remainingBefore.has(c.before.lineId) && remainingAfter.has(c.after.lineId)) {
      take(c.before, c.after, 'category_appearance_position');
    }
  }

  return {
    pairs,
    unmatchedBefore: [...remainingBefore.values()],
    unmatchedAfter: [...remainingAfter.values()],
  };
}

function conditionChangeOf(before: ConditionGrade, after: ConditionGrade): 'worse' | 'better' | null {
  const delta = conditionSeverity(after) - conditionSeverity(before);
  if (delta > 0) return 'worse';
  if (delta < 0) return 'better';
  return null;
}

/**
 * DMS-071, DMS-073: classify a pair of lines matched across two walks.
 *
 * - Another room or site: moved. Moving within a room is not a change (DMS-072).
 * - A counted group with fewer items: not seen, with the negative difference; more items: new.
 * - Otherwise a worse or better grade, or unchanged.
 */
export function classifyMatchedPair(pair: LinePair): WalkChange {
  const { before, after } = pair;
  const quantityDelta = after.quantity - before.quantity;
  const conditionChange = conditionChangeOf(before.condition, after.condition);
  const movedPlace = before.siteId !== after.siteId || before.roomId !== after.roomId;

  let status: ChangeStatus;
  let secondaryCondition: 'worse' | 'better' | null = null;
  if (movedPlace) {
    status = 'moved';
    secondaryCondition = conditionChange;
  } else if (quantityDelta !== 0) {
    status = quantityDelta < 0 ? 'not_seen' : 'new';
    secondaryCondition = conditionChange;
  } else if (conditionChange === 'worse') {
    status = 'condition_worse';
  } else if (conditionChange === 'better') {
    status = 'condition_better';
  } else {
    status = 'unchanged';
  }

  return {
    status,
    assetId: after.assetId ?? before.assetId ?? null,
    beforeLineId: before.lineId,
    afterLineId: after.lineId,
    matchedBy: pair.method,
    quantityBefore: before.quantity,
    quantityAfter: after.quantity,
    quantityDelta: quantityDelta === 0 ? null : quantityDelta,
    conditionChange: secondaryCondition,
    from: movedPlace ? { siteId: before.siteId, roomId: before.roomId } : null,
    to: movedPlace ? { siteId: after.siteId, roomId: after.roomId } : null,
  };
}

export interface CompareWalksInput {
  /** Approved lines of the previous approved walk of the site (DMS-070). */
  readonly before: readonly ComparableLine[];
  /** Approved lines of the walk just approved. */
  readonly after: readonly ComparableLine[];
  /** Rooms with status filmed on the walk just approved. Skipped or not-started rooms were not filmed. */
  readonly filmedRoomIds: Iterable<string>;
  /**
   * Approved lines from the latest walks of the tenant's other sites. Used only to
   * spot an item that moved to another site, and only by asset identity, tag or serial.
   */
  readonly otherSiteLines?: readonly ComparableLine[];
  readonly settings?: MatchSettings;
}

export interface CompareWalksResult {
  /** Changes first in the PRD's order, then rooms not filmed, then unchanged (DMS-074). */
  readonly items: readonly WalkChange[];
  /** Not seen, moved, new, condition worse and condition better. */
  readonly changeCount: number;
  readonly roomNotFilmedCount: number;
  readonly unchangedCount: number;
  readonly countsByStatus: Readonly<Record<ChangeStatus, number>>;
}

function absentChange(before: ComparableLine, status: 'not_seen' | 'room_not_filmed'): WalkChange {
  return {
    status,
    assetId: before.assetId ?? null,
    beforeLineId: before.lineId,
    afterLineId: null,
    matchedBy: null,
    quantityBefore: before.quantity,
    quantityAfter: null,
    quantityDelta: null,
    conditionChange: null,
    from: null,
    to: null,
  };
}

function findElsewhere(line: ComparableLine, elsewhere: readonly ComparableLine[]): LinePair | null {
  const asset = line.assetId ?? null;
  const tag = normaliseIdentifier(line.tagCode);
  const serial = normaliseIdentifier(line.serial);
  for (const other of [...elsewhere].sort(byLineId)) {
    if (other.siteId === line.siteId) continue;
    if (asset !== null && other.assetId === asset) return { before: line, after: other, method: 'asset_identity' };
    if (tag !== null && normaliseIdentifier(other.tagCode) === tag) return { before: line, after: other, method: 'tag' };
    if (serial !== null && normaliseIdentifier(other.serial) === serial) {
      return { before: line, after: other, method: 'serial' };
    }
  }
  return null;
}

/**
 * DMS-070 to DMS-074: compare an approved walk with the previous approved walk of the same site.
 *
 * An item absent from this walk is "not seen" only when its room was filmed. When
 * the room was not filmed it is "room not filmed", never "not seen" (DMS-071).
 */
export function compareWalks(input: CompareWalksInput): CompareWalksResult {
  const filmed = new Set(input.filmedRoomIds);
  const settings = input.settings ?? DEFAULT_MATCH_SETTINGS;
  const { pairs, unmatchedBefore, unmatchedAfter } = matchLinesAcrossWalks(input.before, input.after, settings);

  const items: WalkChange[] = pairs.map(classifyMatchedPair);

  for (const b of unmatchedBefore) {
    const elsewhere = input.otherSiteLines ? findElsewhere(b, input.otherSiteLines) : null;
    if (elsewhere) {
      items.push(classifyMatchedPair(elsewhere));
    } else {
      items.push(absentChange(b, filmed.has(b.roomId) ? 'not_seen' : 'room_not_filmed'));
    }
  }

  for (const a of unmatchedAfter) {
    items.push({
      status: 'new',
      assetId: a.assetId ?? null,
      beforeLineId: null,
      afterLineId: a.lineId,
      matchedBy: null,
      quantityBefore: null,
      quantityAfter: a.quantity,
      quantityDelta: null,
      conditionChange: null,
      from: null,
      to: null,
    });
  }

  const order = (s: ChangeStatus): number => CHANGE_DISPLAY_ORDER.indexOf(s);
  const tieBreak = (c: WalkChange): string => `${c.beforeLineId ?? ''}|${c.afterLineId ?? ''}`;
  items.sort((x, y) => order(x.status) - order(y.status) || (tieBreak(x) < tieBreak(y) ? -1 : 1));

  const countsByStatus = Object.fromEntries(ChangeStatus.values.map((s) => [s, 0])) as Record<ChangeStatus, number>;
  for (const item of items) countsByStatus[item.status] += 1;

  return {
    items,
    changeCount: COUNTED_AS_CHANGE.reduce((sum, s) => sum + countsByStatus[s], 0),
    roomNotFilmedCount: countsByStatus.room_not_filmed,
    unchangedCount: countsByStatus.unchanged,
    countsByStatus,
  };
}

const LAGOS_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' });
const LAGOS_DATE_WITH_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});
const LAGOS_YEAR = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'Africa/Lagos' });

/** A walk date as people in Lagos read it: "3 October", with the year only when it differs from `now`'s. */
export function formatWalkDate(date: Date, now: Date = new Date()): string {
  return LAGOS_YEAR.format(date) === LAGOS_YEAR.format(now) ? LAGOS_DATE.format(date) : LAGOS_DATE_WITH_YEAR.format(date);
}

/** Part 5: the sentence the comparison page opens with, for example "9 changes since the walk on 3 October". */
export function comparisonHeadline(changeCount: number, previousWalkDate: Date, now: Date = new Date()): string {
  const noun = changeCount === 1 ? 'change' : 'changes';
  return `${changeCount} ${noun} since the walk on ${formatWalkDate(previousWalkDate, now)}`;
}

/** DMS-073: "24 chairs, was 32". The caller supplies the plural item name. */
export function describeGroupQuantity(quantityAfter: number, quantityBefore: number, itemNamePlural: string): string {
  return `${quantityAfter} ${itemNamePlural}, was ${quantityBefore}`;
}

/** DMS-073: the signed difference in words, for example "minus 8" or "plus 3". */
export function describeQuantityDelta(delta: number): string {
  if (delta === 0) return 'no change';
  return delta < 0 ? `minus ${Math.abs(delta)}` : `plus ${delta}`;
}
