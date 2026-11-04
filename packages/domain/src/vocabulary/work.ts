import { defineVocabulary, type CodeOf } from './define';

/** Part 4 definitions: an asset line is a single item or a counted group of identical untagged items in one room. */
export const LineKind = defineVocabulary({
  single_item: 'Single item',
  counted_group: 'Counted group',
});
export type LineKind = CodeOf<typeof LineKind>;

/** DMS-051, DMS-052: what a reviewer can do with a proposed line. */
export const ReviewDecisionKind = defineVocabulary({
  accept: 'Accept',
  edit: 'Edit',
  reject: 'Reject',
  merge: 'Merge',
  split: 'Split',
  bulk_approve: 'Bulk approve',
});
export type ReviewDecisionKind = CodeOf<typeof ReviewDecisionKind>;

/**
 * The state of one version of an asset line. "Accepted" with a named approver is
 * what the PRD calls approved: only approved lines appear in reports (Part 4 definitions).
 */
export const LineStatus = defineVocabulary({
  proposed: 'Proposed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  merged: 'Merged into another line',
  split: 'Split into several lines',
});
export type LineStatus = CodeOf<typeof LineStatus>;

/** Part 5: the nine pipeline stages and the one human gate. */
export const PipelineStage = defineVocabulary({
  ingest_and_verify: 'Ingest and verify',
  privacy_pass: 'Privacy pass',
  pick_frames: 'Pick frames',
  detect_and_track: 'Detect and track',
  read_text_and_tags: 'Read text and tags',
  describe_and_grade: 'Describe and grade',
  assemble_and_score: 'Assemble and score',
  human_review: 'Human review',
  reconcile_and_compare: 'Reconcile and compare',
});
export type PipelineStage = CodeOf<typeof PipelineStage>;

/** Part 6 (Modules): stages that run on the separate GPU worker pool (ADR-DMS-02). */
export const GPU_STAGES: readonly PipelineStage[] = Object.freeze([
  'privacy_pass',
  'pick_frames',
  'detect_and_track',
  'read_text_and_tags',
]);

/** Part 6 (Video pipeline mechanics): queued job states, including the dead-letter queue. */
export const JobStatus = defineVocabulary({
  queued: 'Queued',
  leased: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed, will retry',
  dead_lettered: 'Dead-lettered',
});
export type JobStatus = CodeOf<typeof JobStatus>;

/** The lifecycle of a walk. The PRD implies these steps; the names are a proposal (docs/judgement-calls.md). */
export const WalkStatus = defineVocabulary({
  capturing: 'Capturing',
  uploading: 'Uploading',
  processing: 'Processing',
  in_review: 'In review',
  approved: 'Approved',
});
export type WalkStatus = CodeOf<typeof WalkStatus>;

/** DMS-012, DMS-018: the upload state of one clip. A rejected clip failed its fingerprint check. */
export const ClipUploadStatus = defineVocabulary({
  pending: 'Waiting to upload',
  uploading: 'Uploading',
  verified: 'Verified',
  rejected: 'Rejected: fingerprint does not match',
});
export type ClipUploadStatus = CodeOf<typeof ClipUploadStatus>;

/** DMS-080 to DMS-085: report types. */
export const ReportType = defineVocabulary({
  audit_verification: 'Audit verification report',
  insurance_schedule: 'Insurance schedule of contents',
  loss_pack: 'Loss pack',
  maintenance_safety: 'Maintenance and safety list',
  handover_pack: 'Handover pack',
});
export type ReportType = CodeOf<typeof ReportType>;

/** DMS-064: rows in the corrections file. */
export const CorrectionKind = defineVocabulary({
  new_line: 'New line to add',
  location_change: 'Location to change',
  proposed_write_off: 'Proposed for write-off',
});
export type CorrectionKind = CodeOf<typeof CorrectionKind>;

/** DMS-061: how an approved line was matched to the imported register. */
export const ReconMatchMethod = defineVocabulary({
  tag: 'Tag number',
  serial: 'Serial number',
  description: 'Description, category and location',
});
export type ReconMatchMethod = CodeOf<typeof ReconMatchMethod>;

/** DMS-072: how a line was matched to the same asset on the previous walk. */
export const ComparisonMatchMethod = defineVocabulary({
  asset_identity: 'Same confirmed asset',
  tag: 'Tag number',
  serial: 'Serial number',
  category_appearance_position: 'Category, appearance and position in the room',
});
export type ComparisonMatchMethod = CodeOf<typeof ComparisonMatchMethod>;
