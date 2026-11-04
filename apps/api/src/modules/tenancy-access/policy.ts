import { ROLE_PERMISSIONS, canAccessSite, hasPermission, isPermission, requiresMfa, sitesInScope } from '@domesday/domain';
import type { AccessPolicy, Principal } from '../../platform/authz';

/** The access policy every route is checked against: DMS-130, DMS-131, DMS-132. */
export function createAccessPolicy(): AccessPolicy {
  return {
    requiresMfa: (principal) => requiresMfa(principal.grants),
    hasPermission: (principal, permission) => isPermission(permission) && hasPermission(principal.grants, permission),
    canAccessSite: (principal, permission, siteId) => isPermission(permission) && canAccessSite(principal.grants, permission, siteId),
    sitesInScope: (principal, permission) => (isPermission(permission) ? sitesInScope(principal.grants, permission) : new Set<string>()),
  };
}

/** Every permission any of the principal's roles carries. */
export function permissionsOf(principal: Principal): string[] {
  return [...new Set(principal.grants.flatMap((g) => ROLE_PERMISSIONS[g.role]))].sort();
}
