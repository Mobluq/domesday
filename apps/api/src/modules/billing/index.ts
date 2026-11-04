// Public interface of the billing module. Owns: tenant_plans, usage_records
// (DMS-133, DMS-134, DMS-156).
import type { ModuleDefinition } from '../../platform/operation';

export function createBillingModule(): { definition: ModuleDefinition } {
  return { definition: { name: 'billing' } };
}
