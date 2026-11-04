// Shared Domesday vocabulary and pure domain rules. Used by the API, the web app
// and the phone app. Nothing in this package does input or output.

export { defineVocabulary, type CodeOf, type Vocabulary } from './vocabulary/define';
export {
  CHANGE_DISPLAY_ORDER,
  COUNTED_AS_CHANGE,
  ChangeStatus,
  ConditionGrade,
  ConfidenceBand,
  REVIEW_ORDER,
  ReconStatus,
  RoomWalkStatus,
  conditionSeverity,
} from './vocabulary/statuses';
export { InvestigationOutcome, InvestigationStatus, Role } from './vocabulary/people';
export {
  ClipUploadStatus,
  ComparisonMatchMethod,
  CorrectionKind,
  GPU_STAGES,
  JobStatus,
  LineKind,
  LineStatus,
  PipelineStage,
  ReconMatchMethod,
  ReportType,
  ReviewDecisionKind,
  WalkStatus,
} from './vocabulary/work';
export { AuditAction } from './vocabulary/audit';
export { UI_COPY } from './vocabulary/copy';

export {
  MFA_REQUIRED_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  UNBLURRED_VIEWER_ROLES,
  canAccessSite,
  hasPermission,
  isPermission,
  requiresMfa,
  sitesInScope,
  type Permission,
  type RoleGrant,
} from './access/permissions';

export {
  DEFAULT_MATCH_SETTINGS,
  classifyMatchedPair,
  compareWalks,
  comparisonHeadline,
  cosineSimilarity,
  describeGroupQuantity,
  describeQuantityDelta,
  formatWalkDate,
  matchLinesAcrossWalks,
  normaliseIdentifier,
  type ComparableLine,
  type CompareWalksInput,
  type CompareWalksResult,
  type LinePair,
  type MatchSettings,
  type PlaceRef,
  type PositionInRoom,
  type WalkChange,
  type WalkMatchResult,
} from './rules/compare-walks';
export {
  CLOCK_GAP_THRESHOLD_MS,
  RETENTION_MAX_MONTHS,
  RETENTION_MIN_MONTHS,
  assessClockGap,
  checkRetentionMonths,
  isDueForDeletion,
  retentionUntil,
  type ClockGapAssessment,
  type RetentionCheck,
} from './rules/evidence';
export {
  checkApproverSeparation,
  checkBulkApproval,
  checkEditAfterApproval,
  checkWalkApproval,
  isValidSkipReason,
  orderReviewQueue,
  type ApprovalLine,
  type ApprovalRoom,
  type ApproverCheck,
  type BulkApprovalCheck,
  type BulkApprovalLine,
  type BulkRefusalReason,
  type EditAfterApprovalCheck,
  type ReviewerCandidate,
  type WalkApprovalCheck,
} from './rules/review';
export {
  capitalisationFlag,
  checkReadProvenance,
  nairaToKobo,
  notSeenLabel,
  type CapitalisationFlag,
  type Kobo,
  type ReadField,
  type ReadValue,
  type SourceRegion,
} from './rules/register';
export {
  correctionsFrom,
  reconcileWithRegister,
  type CorrectionRow,
  type MatchCandidate,
  type MatchDecision,
  type ReconItem,
  type ReconItemStatus,
  type ReconcilableLine,
  type ReconcileInput,
  type ReconcileResult,
  type RegisterLine,
} from './rules/reconcile';
export {
  CROCKFORD_ALPHABET,
  VERIFICATION_CODE_LENGTH,
  canonicalReportText,
  crockfordBase32,
  formatVerificationCode,
  normaliseVerificationCode,
  verificationCodeFromDigest,
} from './rules/verification';
export {
  WhatsAppSummaryError,
  buildWhatsAppSummary,
  cleanSiteName,
  cleanSummaryLink,
  type WhatsAppSummaryInput,
  type WhatsAppTextMessage,
} from './rules/whatsapp-summary';
