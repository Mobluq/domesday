// Public interface of the reports module. Owns: reports and their verification codes
// (DMS-080 to DMS-088).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createReportsModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'reports',
      resolvers: [sqlResolver('report', 'SELECT site_id FROM reports WHERE id = $1')],
    },
  };
}
