// Public interface of the register module. Owns: account_classes, categories,
// column_mappings, register_imports, register_lines (DMS-003 to DMS-008).
import { sqlResolver, type ModuleDefinition } from '../../platform/operation';

export function createRegisterModule(): { definition: ModuleDefinition } {
  return {
    definition: {
      name: 'register',
      resolvers: [
        // Categories and imports belong to the whole tenant (site null).
        sqlResolver('category', 'SELECT NULL::uuid AS site_id FROM categories WHERE id = $1'),
        sqlResolver('register_import', 'SELECT NULL::uuid AS site_id FROM register_imports WHERE id = $1'),
        sqlResolver('register_line', 'SELECT site_id FROM register_lines WHERE id = $1'),
      ],
    },
  };
}
