// Public interface of the review module. Owns: asset_lines (versions) and
// review_decisions (DMS-050 to DMS-058, DMS-093).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createReviewModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'review',
      resolvers: [
        // API paths use the stable line_id; every version of a line is on the same site.
        sqlResolver('asset_line', 'SELECT site_id FROM asset_lines WHERE line_id = $1 LIMIT 1'),
      ],
    },
  };
}
