import type { ObjectResolver, Principal, ResolvedObject } from './authz';
import type { Queryable } from './db';
import { problem, type ErrorCode } from './errors';
import type { OperationSpec } from './openapi';

/** What a handler returns. A problem body with a 4xx status is committed like any other result. */
export interface OperationResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SiteAccess {
  /** May the caller use this route's permission on the site? Null means tenant-wide. */
  canAccessSite(siteId: string | null): boolean;
  sitesInScope(): 'all' | ReadonlySet<string>;
}

/** Everything a handler needs. By the time it runs, the caller is authenticated and authorised. */
export interface OperationContext {
  readonly operation: OperationSpec;
  readonly principal: Principal;
  /** The request's transaction, as the application role in the caller's tenant (row-level security on). */
  readonly tx: Queryable;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly requestId: string;
  readonly idempotencyKey: string | null;
  readonly now: Date;
  /** Objects the authorisation layer checked, by parameter name. */
  readonly objects: ReadonlyMap<string, ResolvedObject>;
  readonly access: SiteAccess;
}

export type OperationHandler = (ctx: OperationContext) => Promise<OperationResult>;

export interface PublicOperationContext {
  readonly operation: OperationSpec;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
  readonly requestId: string;
  readonly now: Date;
}

export type PublicOperationHandler = (ctx: PublicOperationContext) => Promise<OperationResult>;

/** What each module's index.ts hands to the composition root. */
export interface ModuleDefinition {
  /** Must match the module's tag in openapi/domesday.yaml. */
  readonly name: string;
  /** Handlers by operationId, for operations this module owns. */
  readonly handlers?: Readonly<Record<string, OperationHandler>>;
  readonly publicHandlers?: Readonly<Record<string, PublicOperationHandler>>;
  /** How to find the site of each object type this module owns, for object-level checks. */
  readonly resolvers?: readonly ObjectResolver[];
}

export function ok(body: unknown, status = 200): OperationResult {
  return { status, body };
}

/** A refusal that should still commit, such as a logged fingerprint mismatch. */
export function refusal(
  status: number,
  code: ErrorCode,
  detail: string,
  requestId: string,
  extra: Record<string, unknown> = {},
): OperationResult {
  return { status, body: problem(status, code, detail, { ...extra, requestId }) };
}

/** The typed 501 for operations that are specified but not built yet. */
export function notImplemented(op: OperationSpec, requestId: string): OperationResult {
  return {
    status: 501,
    body: problem(501, 'not_implemented', `${op.operationId} is in the API specification but is not built yet.`, {
      requestId,
      operationId: op.operationId,
      module: op.module,
    }),
  };
}

/**
 * A resolver from one SQL query that takes the object ID as $1 and returns a
 * site_id column (NULL for objects that belong to the whole tenant).
 */
export function sqlResolver(type: string, sql: string): ObjectResolver {
  return {
    type,
    async resolve(tx, id) {
      const { rows } = await tx.query<{ site_id: string | null }>(sql, [id]);
      const row = rows[0];
      return row ? { siteId: row.site_id } : null;
    },
  };
}
