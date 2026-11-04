/** DMS-094: a gap of more than 10 minutes between device and server time is flagged. */
export const CLOCK_GAP_THRESHOLD_MS = 10 * 60 * 1000;

export interface ClockGapAssessment {
  /** Server time minus device time, in milliseconds. Negative when the phone runs fast. */
  readonly gapMs: number;
  /** True when the gap is more than 10 minutes either way. Exactly 10 minutes is not flagged. */
  readonly flagged: boolean;
}

/**
 * DMS-094: server time is the record of truth; device time is kept beside it.
 *
 * `deviceTime` is the phone's clock at the moment it sent the final upload
 * request and `serverTime` the server's clock when that request arrived, so the
 * gap measures clock error rather than how long the clip waited for a network.
 */
export function assessClockGap(deviceTime: Date, serverTime: Date): ClockGapAssessment {
  const device = deviceTime.getTime();
  const server = serverTime.getTime();
  if (Number.isNaN(device) || Number.isNaN(server)) {
    throw new RangeError('assessClockGap needs two valid dates');
  }
  const gapMs = server - device;
  return { gapMs, flagged: Math.abs(gapMs) > CLOCK_GAP_THRESHOLD_MS };
}

/** DMS-136: originals are kept for at least 13 months and at most 7 years. */
export const RETENTION_MIN_MONTHS = 13;
export const RETENTION_MAX_MONTHS = 7 * 12;

export type RetentionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'retention_out_of_bounds'; readonly min: number; readonly max: number };

/** DMS-136: a tenant's retention setting for originals, in whole months. */
export function checkRetentionMonths(months: number): RetentionCheck {
  if (Number.isInteger(months) && months >= RETENTION_MIN_MONTHS && months <= RETENTION_MAX_MONTHS) {
    return { ok: true };
  }
  return { ok: false, code: 'retention_out_of_bounds', min: RETENTION_MIN_MONTHS, max: RETENTION_MAX_MONTHS };
}

/**
 * The date an original may be deleted: `months` calendar months after the server
 * received it, in UTC. A day that does not exist in the target month (31 March plus
 * one month) moves back to that month's last day.
 */
export function retentionUntil(serverTime: Date, months: number): Date {
  const check = checkRetentionMonths(months);
  if (!check.ok) throw new RangeError(`retention must be ${RETENTION_MIN_MONTHS} to ${RETENTION_MAX_MONTHS} months`);
  const year = serverTime.getUTCFullYear();
  const month = serverTime.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(serverTime.getUTCDate(), lastDayOfTarget);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      serverTime.getUTCHours(),
      serverTime.getUTCMinutes(),
      serverTime.getUTCSeconds(),
      serverTime.getUTCMilliseconds(),
    ),
  );
}

/** DMS-136, DMS-096: an original is deleted once retention has passed, unless a legal hold applies. */
export function isDueForDeletion(input: { retentionUntil: Date; legalHold: boolean; now: Date }): boolean {
  return !input.legalHold && input.now.getTime() >= input.retentionUntil.getTime();
}
