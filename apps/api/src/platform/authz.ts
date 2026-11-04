import type { RoleGrant } from '@domesday/domain';
import type { Queryable } from './db';
import { ApiError } from './errors';
import type { OperationSpec } from './openapi';

/**
 * The shared authorisation layer (Part 6, Security; OWASP A01 and API1). Every
 * route passes through it, in this order:
 *
 * 1. authenticate: who is calling (401 unauthenticated);
 * 2. MFA: administrators and reviewers must have set it up (403 mfa_required, DMS-130);
 * 3. permission: the route's x-domesday-permission for any of the caller's roles (403 forbidden);
 * 4. objects: every object in x-domesday-objects must be visible in the caller's
 *    tenant (404 not_found; row-level security hides other tenants) and on a site
 *    the caller's grant covers for that permission (403 forbidden, DMS-131, DMS-132).
 *
 * The policy itself (roles, scopes, partner grants) belongs to the tenancy-access
 * module, which implements the interfaces below. The platform never imports modules.
 */
export interface Principal {
  readonly userId: string;
  /** The tenant this request acts in. For a partner, the client tenant chosen for the request. */
  readonly tenantId: string;
  readonly displayName: string;
  readonly kind: 'user' | 'partner';
  readonly grants: readonly RoleGrant[];
  readonly mfaVerified: boolean;
}

export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** Sign-in is bought, not built (DMS-130, ADR-DMS-05); this is where the provider plugs in. */
export interface Authenticator {
  authenticate(headers: RequestHeaders): Promise<Principal | null>;
}

export interface AccessPolicy {
  requiresMfa(principal: Principal): boolean;
  hasPermission(principal: Principal, permission: string): boolean;
  /** siteId null means the object belongs to the whole tenant. */
  canAccessSite(principal: Principal, permission: string, siteId: string | null): boolean;
  sitesInScope(principal: Principal, permission: string): 'all' | ReadonlySet<string>;
}

/** Finds which site an object belongs to, inside the caller's tenant transaction. */
export interface ObjectResolver {
  readonly type: string;
  resolve(tx: Queryable, id: string): Promise<{ readonly siteId: string | null } | null>;
}

export interface ResolvedObject {
  readonly type: string;
  readonly id: string;
  readonly siteId: string | null;
}

/** Steps 1 to 3: before the request body is even read. */
export async function authenticateRequest(
  op: OperationSpec,
  headers: RequestHeaders,
  authenticator: Authenticator,
  policy: AccessPolicy,
): Promise<Principal | null> {
  if (op.isPublic) return null;
  if (op.permission === null) {
    throw new ApiError(500, 'internal_error', `${op.operationId} declares no permission`);
  }
  const principal = await authenticator.authenticate(headers);
  if (!principal) throw new ApiError(401, 'unauthenticated', 'Sign in to use this API.');
  if (policy.requiresMfa(principal) && !principal.mfaVerified) {
    throw new ApiError(
      403,
      'mfa_required',
      'Administrators and reviewers must set up multi-factor authentication before reaching any data (DMS-130).',
    );
  }
  if (!policy.hasPermission(principal, op.permission)) {
    throw new ApiError(403, 'forbidden', `None of your roles allows ${op.permission}.`);
  }
  return principal;
}

function readPath(source: unknown, dotted: string): unknown {
  let value = source;
  for (const part of dotted.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Step 4: object-level authorisation for every object the route names. */
export async function authoriseObjects(
  tx: Queryable,
  op: OperationSpec,
  principal: Principal,
  input: { params: unknown; query: unknown; body: unknown },
  resolvers: ReadonlyMap<string, ObjectResolver>,
  policy: AccessPolicy,
): Promise<ReadonlyMap<string, ResolvedObject>> {
  const resolved = new Map<string, ResolvedObject>();
  for (const ref of op.objects) {
    const source = ref.in === 'path' ? input.params : ref.in === 'query' ? input.query : input.body;
    const raw = readPath(source, ref.name);
    if (raw === undefined || raw === null) continue;
    const ids = ref.many && Array.isArray(raw) ? raw : [raw];
    const resolver = resolvers.get(ref.type);
    if (!resolver) throw new ApiError(500, 'internal_error', `no resolver for ${ref.type}`);
    for (const [index, id] of ids.entries()) {
      if (typeof id !== 'string') continue;
      const found = await resolver.resolve(tx, id);
      if (!found) throw new ApiError(404, 'not_found', `There is no ${ref.type.replace(/_/g, ' ')} ${id} that you can see.`);
      if (!policy.canAccessSite(principal, op.permission as string, found.siteId)) {
        throw new ApiError(403, 'forbidden', `Your access does not cover the site this ${ref.type.replace(/_/g, ' ')} belongs to.`);
      }
      resolved.set(ref.many ? `${ref.name}[${index}]` : ref.name, { type: ref.type, id, siteId: found.siteId });
    }
  }
  return resolved;
}
