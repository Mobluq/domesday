// Public interface of the evidence module. Owns: audit_events, legal_holds, and the
// retention and fingerprint rules for originals (DMS-090 to DMS-096).
import type { Queryable } from '../../platform/db';
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';
import { appendAuditEvent, listAuditEvents, type AuditEventInput } from './audit-log';

export type { AuditEventInput } from './audit-log';

export interface EvidenceApi {
  /** DMS-092: append an event to the tenant's append-only audit log. */
  appendAuditEvent(tx: Queryable, tenantId: string, event: AuditEventInput): Promise<{ id: string; at: string }>;
}

export function createEvidenceModule(): { definition: ModuleDefinition; api: EvidenceApi } {
  return {
    api: { appendAuditEvent },
    definition: {
      name: 'evidence',
      handlers: { listAuditEvents },
      resolvers: [sqlResolver('legal_hold', 'SELECT site_id FROM legal_holds WHERE id = $1')],
    },
  };
}
