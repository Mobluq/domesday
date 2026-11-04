import type { Role } from '../vocabulary/people';

/**
 * Permissions checked by the API's shared authorisation layer. Every route
 * declares exactly one of these (or is explicitly public).
 *
 * The PRD names the roles (DMS-131) but not what each may do. This matrix is a
 * proposal to confirm with the first customers (docs/judgement-calls.md).
 */
export const PERMISSIONS = Object.freeze([
  'session:read',
  'sites:read',
  'sites:manage',
  'register:read',
  'register:manage',
  'walks:read',
  'walks:capture',
  'walks:approve',
  'processing:read',
  'processing:manage',
  'review:read',
  'review:decide',
  'assets:read',
  'reconciliation:read',
  'reconciliation:run',
  'reconciliation:confirm_match',
  'corrections:export',
  'comparisons:read',
  'investigations:manage',
  'investigations:record_outcome',
  'reports:read',
  'reports:generate',
  'audit:read',
  'evidence:read',
  'evidence:read_unblurred',
  'evidence:legal_hold',
  'tenant:settings',
  'partners:manage',
  'partner:workspace',
  'notifications:manage',
  'billing:read',
] as const);
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

const READ_ALL: readonly Permission[] = [
  'session:read',
  'sites:read',
  'register:read',
  'walks:read',
  'processing:read',
  'review:read',
  'assets:read',
  'reconciliation:read',
  'comparisons:read',
  'reports:read',
  'evidence:read',
];

const TENANT_ADMIN: readonly Permission[] = PERMISSIONS.filter((p) => p !== 'partner:workspace');

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  tenant_administrator: TENANT_ADMIN,
  financial_controller: [
    ...READ_ALL,
    'register:manage',
    'reconciliation:run',
    'reconciliation:confirm_match',
    'corrections:export',
    'investigations:manage',
    'investigations:record_outcome',
    'reports:generate',
    'audit:read',
    'billing:read',
  ],
  facilities_manager: [
    ...READ_ALL,
    'walks:capture',
    'investigations:manage',
    'investigations:record_outcome',
    'reports:generate',
    'notifications:manage',
  ],
  site_manager: [
    'session:read',
    'sites:read',
    'walks:read',
    'walks:capture',
    'processing:read',
    'assets:read',
    'comparisons:read',
    'investigations:record_outcome',
  ],
  reviewer: [
    'session:read',
    'sites:read',
    'walks:read',
    'processing:read',
    'review:read',
    'review:decide',
    'walks:approve',
    'assets:read',
    'comparisons:read',
    'evidence:read',
  ],
  internal_auditor: [...READ_ALL, 'audit:read', 'evidence:read_unblurred'],
  read_only: READ_ALL.filter((p) => p !== 'evidence:read'),
  partner: [
    'session:read',
    'partner:workspace',
    'sites:read',
    'walks:read',
    'assets:read',
    'reconciliation:read',
    'comparisons:read',
    'reports:read',
    'evidence:read',
  ],
});

/** DMS-130: administrators and reviewers must set up MFA before reaching any data. */
export const MFA_REQUIRED_ROLES: readonly Role[] = Object.freeze(['tenant_administrator', 'reviewer']);

/**
 * DMS-102: unblurred originals are viewable only by two named roles. The PRD does
 * not name them; internal auditor and tenant administrator is our proposal.
 */
export const UNBLURRED_VIEWER_ROLES: readonly Role[] = Object.freeze(['internal_auditor', 'tenant_administrator']);

/** One role held by a user, scoped to every site or to a list of sites (DMS-132). */
export interface RoleGrant {
  readonly role: Role;
  readonly sites: 'all' | readonly string[];
}

export function hasPermission(grants: readonly RoleGrant[], permission: Permission): boolean {
  return grants.some((g) => ROLE_PERMISSIONS[g.role].includes(permission));
}

/**
 * DMS-131, DMS-132: may this user use the permission on this site? Objects that
 * belong to the whole tenant (siteId null) need a grant that covers every site.
 */
export function canAccessSite(grants: readonly RoleGrant[], permission: Permission, siteId: string | null): boolean {
  return grants.some((g) => {
    if (!ROLE_PERMISSIONS[g.role].includes(permission)) return false;
    if (g.sites === 'all') return true;
    return siteId !== null && g.sites.includes(siteId);
  });
}

/** DMS-132: the sites whose data a search or list may return for this permission. */
export function sitesInScope(grants: readonly RoleGrant[], permission: Permission): 'all' | ReadonlySet<string> {
  const sites = new Set<string>();
  for (const g of grants) {
    if (!ROLE_PERMISSIONS[g.role].includes(permission)) continue;
    if (g.sites === 'all') return 'all';
    for (const s of g.sites) sites.add(s);
  }
  return sites;
}

/** DMS-130: true when any of the user's roles requires MFA. */
export function requiresMfa(grants: readonly RoleGrant[]): boolean {
  return grants.some((g) => MFA_REQUIRED_ROLES.includes(g.role));
}
