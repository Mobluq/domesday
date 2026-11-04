import { UI_COPY } from '../vocabulary/copy';
import { InvestigationOutcome } from '../vocabulary/people';

/** Money is held as whole kobo (1 naira = 100 kobo) so sums never suffer floating-point error. */
export type Kobo = number;

export function nairaToKobo(naira: number): Kobo {
  if (!Number.isFinite(naira) || naira < 0) throw new RangeError('naira must be a finite, non-negative amount');
  return Math.round(naira * 100);
}

export interface CapitalisationFlag {
  readonly belowThreshold: boolean;
  /** "Below threshold" when flagged (DMS-007), otherwise null. */
  readonly label: string | null;
  /** False when the item has no value to judge, such as an unrecorded item. */
  readonly valueKnown: boolean;
}

/**
 * DMS-007: with a capitalisation threshold set, a lower-value item is still counted
 * but flagged "below threshold". The comparison uses the item's unit cost in kobo.
 * An item exactly at the threshold is capitalised.
 */
export function capitalisationFlag(input: {
  readonly unitCostKobo: Kobo | null;
  readonly thresholdKobo: Kobo | null;
}): CapitalisationFlag {
  const valueKnown = input.unitCostKobo !== null;
  if (input.thresholdKobo === null || input.unitCostKobo === null) {
    return { belowThreshold: false, label: null, valueKnown };
  }
  const belowThreshold = input.unitCostKobo < input.thresholdKobo;
  return { belowThreshold, label: belowThreshold ? UI_COPY.belowThreshold : null, valueKnown };
}

/**
 * DMS-063: a register line or asset that was not seen is labelled "not seen on
 * this walk" until someone investigates and records an outcome. Only then may it
 * carry an outcome label such as "Lost" or "Stolen".
 */
export function notSeenLabel(recordedOutcome: InvestigationOutcome | null): string {
  return recordedOutcome === null ? 'Not seen on this walk' : InvestigationOutcome.label(recordedOutcome);
}

/** A region of a frame, each value a share of the frame from 0 to 1. */
export interface SourceRegion {
  readonly frameId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ReadValue {
  readonly value: string;
  readonly sourceRegion: SourceRegion | null;
}

export type ReadField = 'serial' | 'model' | 'tagCode';

/**
 * Part 5 ("never guess a number") and DMS-033: serial, model and tag numbers come
 * only from text the system actually read. A value without the image region it
 * was read from is rejected.
 */
export function checkReadProvenance(fields: Partial<Record<ReadField, ReadValue | null>>): {
  readonly ok: boolean;
  readonly missingSourceRegion: readonly ReadField[];
} {
  const missingSourceRegion: ReadField[] = [];
  for (const field of ['serial', 'model', 'tagCode'] as const) {
    const read = fields[field];
    if (!read || read.value.trim() === '') continue;
    const r = read.sourceRegion;
    const valid =
      r !== null &&
      r.frameId.length > 0 &&
      [r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
      r.width > 0 &&
      r.height > 0;
    if (!valid) missingSourceRegion.push(field);
  }
  return { ok: missingSourceRegion.length === 0, missingSourceRegion };
}
