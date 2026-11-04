// Public interface of the sites module. Owns: sites, site_groups, site_group_members,
// buildings, floors, rooms, room_imports (DMS-001, DMS-002).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createSitesModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'sites',
      resolvers: [
        sqlResolver('site', 'SELECT id AS site_id FROM sites WHERE id = $1'),
        sqlResolver('building', 'SELECT site_id FROM buildings WHERE id = $1'),
        sqlResolver(
          'floor',
          'SELECT b.site_id FROM floors f JOIN buildings b ON b.tenant_id = f.tenant_id AND b.id = f.building_id WHERE f.id = $1',
        ),
        sqlResolver('room', 'SELECT site_id FROM rooms WHERE id = $1'),
        sqlResolver('room_import', 'SELECT site_id FROM room_imports WHERE id = $1'),
      ],
    },
  };
}
