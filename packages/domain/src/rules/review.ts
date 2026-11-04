import { REVIEW_ORDER, type ConfidenceBand, type RoomWalkStatus } from '../vocabulary/statuses';
import type { ReviewDecisionKind } from '../vocabulary/work';

/** DMS-010: a skipped room needs a reason. Any non-blank text counts. */
export function isValidSkipReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length > 0;
}

export interface ApprovalLine {
  readonly lineId: string;
  /** The reviewer's decision, or null while the line is undecided. */
  readonly decision: ReviewDecisionKind | null;
}

export interface ApprovalRoom {
  readonly roomId: string;
  readonly status: RoomWalkStatus;
  readonly skipReason?: string | null;
}

export type WalkApprovalCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'walk_not_ready_for_approval';
      /** Lines with no decision yet, so the app can show them (DMS-058). */
      readonly undecidedLineIds: readonly string[];
      readonly roomsNotStarted: readonly string[];
      readonly roomsSkippedWithoutReason: readonly string[];
    };

/** DMS-058: a walk is approved only when every line has a decision and every room is filmed or has a skip reason. */
export function checkWalkApproval(input: {
  readonly lines: readonly ApprovalLine[];
  readonly rooms: readonly ApprovalRoom[];
}): WalkApprovalCheck {
  const undecidedLineIds = input.lines.filter((l) => l.decision === null).map((l) => l.lineId);
  const roomsNotStarted = input.rooms.filter((r) => r.status === 'not_started').map((r) => r.roomId);
  const roomsSkippedWithoutReason = input.rooms
    .filter((r) => r.status === 'skipped' && !isValidSkipReason(r.skipReason))
    .map((r) => r.roomId);
  if (undecidedLineIds.length === 0 && roomsNotStarted.length === 0 && roomsSkippedWithoutReason.length === 0) {
    return { ok: true };
  }
  return { ok: false, code: 'walk_not_ready_for_approval', undecidedLineIds, roomsNotStarted, roomsSkippedWithoutReason };
}

export interface ReviewerCandidate {
  readonly userId: string;
  readonly displayName: string;
}

export type ApproverCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: 'capturer_cannot_approve';
      /** Another eligible reviewer to name in the refusal, or null when there is none. */
      readonly suggestedReviewer: ReviewerCandidate | null;
    };

/**
 * DMS-054: the person who filmed a room cannot approve its lines, so the capturer
 * of a walk is never its sole approver, unless the tenant has switched the rule off
 * for small sites. A refusal names another eligible reviewer.
 */
export function checkApproverSeparation(input: {
  readonly separationRuleOn: boolean;
  readonly approverUserId: string;
  /** Users credited with filming the rooms whose lines are being approved (DMS-022). */
  readonly capturerUserIds: Iterable<string>;
  /** Reviewers who may approve on this site. */
  readonly eligibleReviewers: readonly ReviewerCandidate[];
}): ApproverCheck {
  if (!input.separationRuleOn) return { allowed: true };
  const capturers = new Set(input.capturerUserIds);
  if (!capturers.has(input.approverUserId)) return { allowed: true };
  const suggestedReviewer =
    [...input.eligibleReviewers]
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'en-GB') || (a.userId < b.userId ? -1 : 1))
      .find((r) => r.userId !== input.approverUserId && !capturers.has(r.userId)) ?? null;
  return { allowed: false, code: 'capturer_cannot_approve', suggestedReviewer };
}

export interface BulkApprovalLine {
  readonly lineId: string;
  readonly band: ConfidenceBand;
  readonly decided: boolean;
}

export type BulkRefusalReason =
  | 'low_confidence_needs_individual_decision'
  | 'only_high_confidence_can_be_bulk_approved'
  | 'not_shown_in_grid'
  | 'already_decided'
  | 'unknown_line';

export interface BulkApprovalCheck {
  /** True only when every requested line can be approved in bulk. The API refuses the whole request otherwise. */
  readonly ok: boolean;
  readonly approvable: readonly string[];
  readonly refused: readonly { readonly lineId: string; readonly reason: BulkRefusalReason }[];
}

/**
 * DMS-037: a low-confidence line can never be approved by bulk action.
 * DMS-052: only high-confidence lines, and only after the reviewer has seen them in the grid.
 */
export function checkBulkApproval(input: {
  readonly requestedLineIds: readonly string[];
  readonly lines: readonly BulkApprovalLine[];
  readonly shownInGridLineIds: Iterable<string>;
}): BulkApprovalCheck {
  const byId = new Map(input.lines.map((l) => [l.lineId, l] as const));
  const shown = new Set(input.shownInGridLineIds);
  const approvable: string[] = [];
  const refused: { lineId: string; reason: BulkRefusalReason }[] = [];
  for (const lineId of new Set(input.requestedLineIds)) {
    const line = byId.get(lineId);
    if (!line) refused.push({ lineId, reason: 'unknown_line' });
    else if (line.band === 'low') refused.push({ lineId, reason: 'low_confidence_needs_individual_decision' });
    else if (line.band !== 'high') refused.push({ lineId, reason: 'only_high_confidence_can_be_bulk_approved' });
    else if (line.decided) refused.push({ lineId, reason: 'already_decided' });
    else if (!shown.has(lineId)) refused.push({ lineId, reason: 'not_shown_in_grid' });
    else approvable.push(lineId);
  }
  return { ok: refused.length === 0 && approvable.length > 0, approvable, refused };
}

/** DMS-050: order the review queue low, medium, then high confidence, keeping the original order within a band. */
export function orderReviewQueue<T extends { readonly band: ConfidenceBand }>(lines: readonly T[]): T[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => REVIEW_ORDER.indexOf(a.line.band) - REVIEW_ORDER.indexOf(b.line.band) || a.index - b.index)
    .map(({ line }) => line);
}

export type EditAfterApprovalCheck = { readonly ok: true } | { readonly ok: false; readonly code: 'reason_required' };

/** DMS-093: an edit to an approved line needs a reason and creates a new version. */
export function checkEditAfterApproval(input: {
  readonly lineApproved: boolean;
  readonly reason?: string | null;
}): EditAfterApprovalCheck {
  if (!input.lineApproved) return { ok: true };
  return typeof input.reason === 'string' && input.reason.trim().length > 0 ? { ok: true } : { ok: false, code: 'reason_required' };
}
