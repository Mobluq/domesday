import { describe, expect, it } from 'vitest';
import {
  CLOCK_GAP_THRESHOLD_MS,
  RETENTION_MAX_MONTHS,
  RETENTION_MIN_MONTHS,
  assessClockGap,
  capitalisationFlag,
  checkApproverSeparation,
  checkBulkApproval,
  checkEditAfterApproval,
  checkReadProvenance,
  checkRetentionMonths,
  checkWalkApproval,
  isDueForDeletion,
  nairaToKobo,
  notSeenLabel,
  orderReviewQueue,
  retentionUntil,
  type BulkApprovalLine,
} from '../src';

describe('DMS-094: server time is the record of truth', () => {
  const server = new Date('2026-11-03T10:00:00Z');

  it('Given a phone clock set 2 days behind, then the clip carries both times and a clock-gap flag', () => {
    const device = new Date(server.getTime() - 2 * 24 * 60 * 60 * 1000);
    const gap = assessClockGap(device, server);
    expect(gap.flagged).toBe(true);
    expect(gap.gapMs).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it('A gap of exactly 10 minutes is not flagged; one millisecond more is', () => {
    expect(assessClockGap(new Date(server.getTime() - CLOCK_GAP_THRESHOLD_MS), server).flagged).toBe(false);
    expect(assessClockGap(new Date(server.getTime() - CLOCK_GAP_THRESHOLD_MS - 1), server).flagged).toBe(true);
  });

  it('A phone running fast is flagged too', () => {
    expect(assessClockGap(new Date(server.getTime() + 11 * 60 * 1000), server)).toMatchObject({ flagged: true, gapMs: -660000 });
  });

  it('Refuses invalid dates', () => {
    expect(() => assessClockGap(new Date('not a date'), server)).toThrow(RangeError);
  });
});

describe('DMS-136: retention of originals between 13 months and 7 years', () => {
  it('Accepts 13 to 84 whole months and refuses anything else', () => {
    expect(RETENTION_MIN_MONTHS).toBe(13);
    expect(RETENTION_MAX_MONTHS).toBe(84);
    expect(checkRetentionMonths(13).ok).toBe(true);
    expect(checkRetentionMonths(24).ok).toBe(true);
    expect(checkRetentionMonths(84).ok).toBe(true);
    expect(checkRetentionMonths(12)).toEqual({ ok: false, code: 'retention_out_of_bounds', min: 13, max: 84 });
    expect(checkRetentionMonths(85).ok).toBe(false);
    expect(checkRetentionMonths(13.5).ok).toBe(false);
  });

  it('Counts calendar months from server time, moving a missing day to the end of the month', () => {
    expect(retentionUntil(new Date('2026-01-15T08:00:00Z'), 24).toISOString()).toBe('2028-01-15T08:00:00.000Z');
    expect(retentionUntil(new Date('2026-01-31T08:00:00Z'), 13).toISOString()).toBe('2027-02-28T08:00:00.000Z');
    expect(() => retentionUntil(new Date(), 12)).toThrow(RangeError);
  });

  it('Given retention of 24 months, when a clip passes 24 months with no legal hold, then it is due for deletion', () => {
    const until = retentionUntil(new Date('2024-01-01T00:00:00Z'), 24);
    expect(isDueForDeletion({ retentionUntil: until, legalHold: false, now: new Date('2026-01-01T00:00:01Z') })).toBe(true);
    expect(isDueForDeletion({ retentionUntil: until, legalHold: false, now: new Date('2025-12-31T23:59:59Z') })).toBe(false);
  });

  it('DMS-096: a legal hold overrides normal deletion', () => {
    const until = new Date('2025-01-01T00:00:00Z');
    expect(isDueForDeletion({ retentionUntil: until, legalHold: true, now: new Date('2030-01-01T00:00:00Z') })).toBe(false);
  });
});

describe('DMS-058: walk approval', () => {
  const rooms = [
    { roomId: 'r1', status: 'filmed' as const },
    { roomId: 'r2', status: 'skipped' as const, skipReason: 'Locked, key with security' },
  ];

  it('Given one line still undecided, when the reviewer tries to approve the walk, then it is refused and shows the line', () => {
    const check = checkWalkApproval({
      lines: [
        { lineId: 'l1', decision: 'accept' },
        { lineId: 'l2', decision: null },
      ],
      rooms,
    });
    expect(check).toEqual({
      ok: false,
      code: 'walk_not_ready_for_approval',
      undecidedLineIds: ['l2'],
      roomsNotStarted: [],
      roomsSkippedWithoutReason: [],
    });
  });

  it('Refuses while a room is not started, or skipped without a reason', () => {
    const check = checkWalkApproval({
      lines: [{ lineId: 'l1', decision: 'reject' }],
      rooms: [
        { roomId: 'r1', status: 'not_started' },
        { roomId: 'r2', status: 'skipped', skipReason: '   ' },
      ],
    });
    expect(check).toMatchObject({ ok: false, roomsNotStarted: ['r1'], roomsSkippedWithoutReason: ['r2'] });
  });

  it('Approves when every line has a decision and every room is filmed or has a skip reason', () => {
    const check = checkWalkApproval({
      lines: [
        { lineId: 'l1', decision: 'accept' },
        { lineId: 'l2', decision: 'merge' },
        { lineId: 'l3', decision: 'bulk_approve' },
      ],
      rooms,
    });
    expect(check).toEqual({ ok: true });
  });
});

describe('DMS-054: the capturer cannot be the sole approver', () => {
  const reviewers = [
    { userId: 'u-reviewer-a', displayName: 'Reviewer A' },
    { userId: 'u-reviewer-b', displayName: 'Reviewer B' },
  ];

  it('Given the rule is on, when the person who filmed a room tries to approve its lines, then it refuses and names another eligible reviewer', () => {
    const check = checkApproverSeparation({
      separationRuleOn: true,
      approverUserId: 'u-reviewer-a',
      capturerUserIds: ['u-reviewer-a'],
      eligibleReviewers: reviewers,
    });
    expect(check).toEqual({ allowed: false, code: 'capturer_cannot_approve', suggestedReviewer: reviewers[1] });
  });

  it('Never suggests someone who also filmed those rooms, and says so when nobody else is eligible', () => {
    const check = checkApproverSeparation({
      separationRuleOn: true,
      approverUserId: 'u-reviewer-a',
      capturerUserIds: ['u-reviewer-a', 'u-reviewer-b'],
      eligibleReviewers: reviewers,
    });
    expect(check).toEqual({ allowed: false, code: 'capturer_cannot_approve', suggestedReviewer: null });
  });

  it('Allows a reviewer who did not film the rooms', () => {
    expect(
      checkApproverSeparation({ separationRuleOn: true, approverUserId: 'u-reviewer-b', capturerUserIds: ['u-reviewer-a'], eligibleReviewers: reviewers }),
    ).toEqual({ allowed: true });
  });

  it('Allows the capturer when the tenant has switched the rule off for small sites', () => {
    expect(
      checkApproverSeparation({ separationRuleOn: false, approverUserId: 'u-reviewer-a', capturerUserIds: ['u-reviewer-a'], eligibleReviewers: [] }),
    ).toEqual({ allowed: true });
  });
});

describe('DMS-037 and DMS-052: bulk approval', () => {
  it('Given 200 high-confidence lines seen in the grid, when the reviewer selects all and approves, then all are approvable', () => {
    const lines: BulkApprovalLine[] = Array.from({ length: 200 }, (_, i) => ({ lineId: `l${i}`, band: 'high', decided: false }));
    const ids = lines.map((l) => l.lineId);
    const check = checkBulkApproval({ requestedLineIds: ids, lines, shownInGridLineIds: ids });
    expect(check.ok).toBe(true);
    expect(check.approvable).toHaveLength(200);
  });

  it('Given a line with low confidence, then it cannot be approved by bulk action and needs an individual decision', () => {
    const lines: BulkApprovalLine[] = [
      { lineId: 'hi', band: 'high', decided: false },
      { lineId: 'lo', band: 'low', decided: false },
    ];
    const check = checkBulkApproval({ requestedLineIds: ['hi', 'lo'], lines, shownInGridLineIds: ['hi', 'lo'] });
    expect(check.ok).toBe(false);
    expect(check.refused).toEqual([{ lineId: 'lo', reason: 'low_confidence_needs_individual_decision' }]);
  });

  it('Refuses medium-confidence lines, lines not shown in the grid, decided lines and unknown lines', () => {
    const lines: BulkApprovalLine[] = [
      { lineId: 'med', band: 'medium', decided: false },
      { lineId: 'hidden', band: 'high', decided: false },
      { lineId: 'done', band: 'high', decided: true },
    ];
    const check = checkBulkApproval({ requestedLineIds: ['med', 'hidden', 'done', 'ghost'], lines, shownInGridLineIds: ['med', 'done'] });
    expect(check.refused.map((r) => r.reason)).toEqual([
      'only_high_confidence_can_be_bulk_approved',
      'not_shown_in_grid',
      'already_decided',
      'unknown_line',
    ]);
    expect(check.ok).toBe(false);
  });
});

describe('DMS-050 and DMS-093: review queue order and edits after approval', () => {
  it('Orders lines low, medium, then high confidence', () => {
    const queue = orderReviewQueue([
      { id: 'a', band: 'high' as const },
      { id: 'b', band: 'low' as const },
      { id: 'c', band: 'medium' as const },
      { id: 'd', band: 'low' as const },
    ]);
    expect(queue.map((l) => l.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('Given an approved line, when it is changed, then a reason is required', () => {
    expect(checkEditAfterApproval({ lineApproved: true })).toEqual({ ok: false, code: 'reason_required' });
    expect(checkEditAfterApproval({ lineApproved: true, reason: ' ' })).toEqual({ ok: false, code: 'reason_required' });
    expect(checkEditAfterApproval({ lineApproved: true, reason: 'Recount found 31' })).toEqual({ ok: true });
    expect(checkEditAfterApproval({ lineApproved: false })).toEqual({ ok: true });
  });
});

describe('DMS-007: capitalisation threshold', () => {
  it('Given a threshold of ₦250,000, when a ₦40,000 item is approved, then it is counted but flagged "below threshold"', () => {
    const flag = capitalisationFlag({ unitCostKobo: nairaToKobo(40_000), thresholdKobo: nairaToKobo(250_000) });
    expect(flag).toEqual({ belowThreshold: true, label: 'Below threshold', valueKnown: true });
  });

  it('An item at the threshold is capitalised, and nothing is flagged without a threshold or a value', () => {
    expect(capitalisationFlag({ unitCostKobo: 25_000_000, thresholdKobo: 25_000_000 }).belowThreshold).toBe(false);
    expect(capitalisationFlag({ unitCostKobo: 100, thresholdKobo: null }).belowThreshold).toBe(false);
    expect(capitalisationFlag({ unitCostKobo: null, thresholdKobo: 25_000_000 })).toEqual({
      belowThreshold: false,
      label: null,
      valueKnown: false,
    });
  });

  it('Holds money as whole kobo', () => {
    expect(nairaToKobo(250_000)).toBe(25_000_000);
    expect(nairaToKobo(0.1 + 0.2)).toBe(30);
    expect(() => nairaToKobo(-1)).toThrow(RangeError);
  });
});

describe('DMS-063: "not seen" until an outcome is recorded', () => {
  it('Labels a not-seen item "Not seen on this walk" until someone records an outcome', () => {
    expect(notSeenLabel(null)).toBe('Not seen on this walk');
    expect(notSeenLabel('stolen')).toBe('Stolen');
    expect(notSeenLabel('transferred')).toBe('Transferred');
  });
});

describe('Part 5: never guess a number', () => {
  const region = { frameId: 'f1', x: 0.1, y: 0.2, width: 0.3, height: 0.1 };

  it('Accepts serial, model and tag values that keep the region they were read from', () => {
    expect(checkReadProvenance({ serial: { value: 'SN123', sourceRegion: region }, model: null })).toEqual({
      ok: true,
      missingSourceRegion: [],
    });
  });

  it('Rejects a value with no source region, or with a region outside the frame', () => {
    const check = checkReadProvenance({
      serial: { value: 'SN123', sourceRegion: null },
      tagCode: { value: 'TAG-9', sourceRegion: { ...region, width: 1.5 } },
    });
    expect(check).toEqual({ ok: false, missingSourceRegion: ['serial', 'tagCode'] });
  });
});
