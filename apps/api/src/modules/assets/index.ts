// Public interface of the assets module. Owns: assets, identity across walks and
// condition history (DMS-072, DMS-076).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createAssetsModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'assets',
      resolvers: [sqlResolver('asset', 'SELECT current_site_id AS site_id FROM assets WHERE id = $1')],
    },
  };
}
