import { defineVocabulary, type CodeOf } from './define';

/**
 * DMS-092: actions the append-only audit log records, plus the events other
 * requirements say must be logged (DMS-018, DMS-088, DMS-090, DMS-096, DMS-102, DMS-136).
 */
export const AuditAction = defineVocabulary({
  'session.sign_in': 'Signed in',
  'review.decision': 'Review decision',
  'review.bulk_approval': 'Bulk approval',
  'walk.approved': 'Walk approved',
  'line.edited_after_approval': 'Line edited after approval',
  'export.corrections': 'Corrections exported',
  'export.tenant_data': 'Tenant data exported',
  'report.generated': 'Report generated',
  'evidence.accessed': 'Evidence opened',
  'evidence.unblurred_viewed': 'Unblurred original opened',
  'evidence.access_refused': 'Evidence access refused',
  'permission.changed': 'Permission changed',
  'partner_grant.changed': 'Partner access changed',
  'clip.verified': 'Clip fingerprint verified',
  'clip.fingerprint_mismatch': 'Clip rejected: fingerprint does not match',
  'storage.change_refused': 'Change to write-once evidence refused',
  'retention.original_deleted': 'Original deleted at end of retention',
  'legal_hold.placed': 'Legal hold placed',
  'legal_hold.lift_approved': 'Legal hold lift approved',
  'legal_hold.lifted': 'Legal hold lifted',
  'investigation.assigned': 'Investigation assigned',
  'investigation.outcome_recorded': 'Investigation outcome recorded',
  'settings.changed': 'Tenant settings changed',
});
export type AuditAction = CodeOf<typeof AuditAction>;
