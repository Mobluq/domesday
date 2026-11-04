// Public interface of the comparison module. Owns: comparisons, change_items,
// investigations (DMS-070 to DMS-077, DMS-113).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createComparisonModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'comparison',
      resolvers: [
        sqlResolver('comparison', 'SELECT site_id FROM comparisons WHERE id = $1'),
        sqlResolver(
          'change_item',
          `SELECT c.site_id FROM change_items i
           JOIN comparisons c ON c.tenant_id = i.tenant_id AND c.id = i.comparison_id WHERE i.id = $1`,
        ),
        sqlResolver(
          'investigation',
          `SELECT c.site_id FROM investigations v
           JOIN change_items i ON i.tenant_id = v.tenant_id AND i.id = v.change_item_id
           JOIN comparisons c ON c.tenant_id = i.tenant_id AND c.id = i.comparison_id WHERE v.id = $1`,
        ),
      ],
    },
  };
}
