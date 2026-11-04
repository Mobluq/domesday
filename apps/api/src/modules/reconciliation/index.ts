// Public interface of the reconciliation module. Owns: reconciliations,
// reconciliation_matches, corrections_exports (DMS-060 to DMS-066).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createReconciliationModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'reconciliation',
      resolvers: [
        // A group reconciliation has no site, so it needs access to every site.
        sqlResolver('reconciliation', 'SELECT site_id FROM reconciliations WHERE id = $1'),
        sqlResolver(
          'reconciliation_match',
          `SELECT r.site_id FROM reconciliation_matches m
           JOIN reconciliations r ON r.tenant_id = m.tenant_id AND r.id = m.reconciliation_id WHERE m.id = $1`,
        ),
        sqlResolver(
          'corrections_export',
          `SELECT r.site_id FROM corrections_exports e
           JOIN reconciliations r ON r.tenant_id = e.tenant_id AND r.id = e.reconciliation_id WHERE e.id = $1`,
        ),
      ],
    },
  };
}
