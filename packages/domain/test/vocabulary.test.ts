import { describe, expect, it } from 'vitest';
import {
  AuditAction,
  ChangeStatus,
  ClipUploadStatus,
  ComparisonMatchMethod,
  ConditionGrade,
  ConfidenceBand,
  CorrectionKind,
  InvestigationOutcome,
  InvestigationStatus,
  JobStatus,
  LineKind,
  LineStatus,
  PipelineStage,
  REVIEW_ORDER,
  ReconMatchMethod,
  ReconStatus,
  ReportType,
  ReviewDecisionKind,
  Role,
  RoomWalkStatus,
  UI_COPY,
  WalkStatus,
  conditionSeverity,
  type Vocabulary,
} from '../src';

const ALL: Record<string, Vocabulary<string>> = {
  AuditAction,
  ChangeStatus,
  ClipUploadStatus,
  ComparisonMatchMethod,
  ConditionGrade,
  ConfidenceBand,
  CorrectionKind,
  InvestigationOutcome,
  InvestigationStatus,
  JobStatus,
  LineKind,
  LineStatus,
  PipelineStage,
  ReconMatchMethod,
  ReconStatus,
  ReportType,
  ReviewDecisionKind,
  Role,
  RoomWalkStatus,
  WalkStatus,
};

describe('shared vocabulary uses the PRD\'s exact words', () => {
  it('DMS-071: change statuses', () => {
    expect(ChangeStatus.labels).toEqual({
      unchanged: 'Unchanged',
      not_seen: 'Not seen on this walk',
      moved: 'Moved',
      new: 'New',
      condition_worse: 'Condition worse',
      condition_better: 'Condition better',
      room_not_filmed: 'Room not filmed',
    });
  });

  it('DMS-060: reconciliation statuses', () => {
    expect(ReconStatus.labels).toEqual({
      found: 'Found',
      found_elsewhere: 'Found elsewhere',
      unrecorded: 'Unrecorded',
      not_seen: 'Not seen on this walk',
    });
  });

  it('DMS-036: condition grades, best first, with increasing severity', () => {
    expect(ConditionGrade.values).toEqual(['good', 'fair', 'poor', 'not_working_or_unsafe']);
    expect(ConditionGrade.label('not_working_or_unsafe')).toBe('Not working or unsafe');
    expect(ConditionGrade.values.map(conditionSeverity)).toEqual([0, 1, 2, 3]);
  });

  it('DMS-037 and DMS-050: confidence bands, reviewed low first', () => {
    expect(ConfidenceBand.values).toEqual(['high', 'medium', 'low']);
    expect(REVIEW_ORDER).toEqual(['low', 'medium', 'high']);
  });

  it('DMS-010: room walk statuses', () => {
    expect(RoomWalkStatus.labels).toEqual({ not_started: 'Not started', filmed: 'Filmed', skipped: 'Skipped' });
  });

  it('DMS-131: roles', () => {
    expect(Role.values).toEqual([
      'tenant_administrator',
      'financial_controller',
      'facilities_manager',
      'site_manager',
      'reviewer',
      'internal_auditor',
      'read_only',
      'partner',
    ]);
    expect(Role.label('site_manager')).toBe('Site manager (capture)');
  });

  it('DMS-075: investigation outcomes, with "lost or stolen" proposed as two outcomes', () => {
    expect(InvestigationOutcome.labels).toEqual({
      found: 'Found',
      transferred: 'Transferred',
      disposed: 'Disposed',
      written_off: 'Written off',
      lost: 'Lost',
      stolen: 'Stolen',
    });
  });

  it('Part 5: the nine pipeline stages in order', () => {
    expect(PipelineStage.values).toHaveLength(9);
    expect(PipelineStage.values[0]).toBe('ingest_and_verify');
    expect(PipelineStage.values[8]).toBe('reconcile_and_compare');
  });

  it('DMS-103 and DMS-013: fixed capture wording', () => {
    expect(UI_COPY.recordingNotice).toBe('Recording spaces for asset count');
    expect(UI_COPY.slowDown).toBe('Slow down');
    expect(UI_COPY.evidenceBy).toBe('Evidence by Domesday');
  });
});

describe('DMS-063 and Part 5: nothing is called missing, lost or stolen before an outcome is recorded', () => {
  const accusing = /\b(missing|lost|stolen|theft|thief)\b/i;

  it('No label outside the recorded investigation outcomes uses an accusing word', () => {
    for (const [name, vocab] of Object.entries(ALL)) {
      if (name === 'InvestigationOutcome') continue;
      for (const label of Object.values(vocab.labels)) {
        expect(label, `${name}: ${label}`).not.toMatch(accusing);
      }
    }
    for (const text of Object.values(UI_COPY)) expect(text).not.toMatch(accusing);
  });

  it('The not-seen label is "Not seen on this walk" wherever it appears', () => {
    expect(ChangeStatus.label('not_seen')).toBe('Not seen on this walk');
    expect(ReconStatus.label('not_seen')).toBe('Not seen on this walk');
  });
});

describe('vocabulary mechanics', () => {
  it('Every code is unique, stable snake_case (dotted for audit actions), and has a non-empty label', () => {
    for (const [name, vocab] of Object.entries(ALL)) {
      expect(new Set(vocab.values).size, name).toBe(vocab.values.length);
      for (const code of vocab.values) {
        expect(code, name).toMatch(/^[a-z][a-z_]*(\.[a-z_]+)?$/);
        expect(vocab.label(code).trim().length, `${name}.${code}`).toBeGreaterThan(0);
      }
    }
  });

  it('is() accepts only known codes, and vocabularies cannot be changed at run time', () => {
    expect(ChangeStatus.is('moved')).toBe(true);
    expect(ChangeStatus.is('missing')).toBe(false);
    expect(ChangeStatus.is('toString')).toBe(false);
    expect(Object.isFrozen(ChangeStatus.labels)).toBe(true);
    expect(Object.isFrozen(ChangeStatus.values)).toBe(true);
  });
});
