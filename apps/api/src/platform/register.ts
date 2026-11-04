import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import {
  authenticateRequest,
  authoriseObjects,
  type AccessPolicy,
  type Authenticator,
  type ObjectResolver,
  type Principal,
} from './authz';
import type { Database } from './db';
import { ApiError, PROBLEM_CONTENT_TYPE, problem } from './errors';
import { requestHash, type IdempotencyStore } from './idempotency';
import type { LoadedSpec, OperationSpec, Validators } from './openapi';
import {
  notImplemented,
  type ModuleDefinition,
  type OperationHandler,
  type OperationResult,
  type PublicOperationHandler,
} from './operation';

declare module 'fastify' {
  interface FastifyContextConfig {
    operation?: OperationSpec;
  }
  interface FastifyRequest {
    principal?: Principal | null;
  }
}

export interface RegisterOptions {
  readonly spec: LoadedSpec;
  readonly validators: Validators;
  readonly modules: readonly ModuleDefinition[];
  /** Tags allowed in the specification: the Part 6 modules plus "platform". */
  readonly knownModules: readonly string[];
  readonly db: Database;
  readonly authenticator: Authenticator;
  readonly policy: AccessPolicy;
  readonly idempotency: IdempotencyStore;
  readonly now: () => Date;
  /** Per-client limit for public routes such as report verification (DMS-157). */
  readonly publicRateLimitPerMinute: number;
}

interface Registry {
  readonly handlers: ReadonlyMap<string, OperationHandler>;
  readonly publicHandlers: ReadonlyMap<string, PublicOperationHandler>;
  readonly resolvers: ReadonlyMap<string, ObjectResolver>;
}

/** Checks modules against the specification. Anything that does not fit stops the server from starting. */
export function buildRegistry(spec: LoadedSpec, modules: readonly ModuleDefinition[], knownModules: readonly string[]): Registry {
  const operations = new Map(spec.operations.map((o) => [o.operationId, o] as const));
  const handlers = new Map<string, OperationHandler>();
  const publicHandlers = new Map<string, PublicOperationHandler>();
  const resolvers = new Map<string, ObjectResolver>();

  for (const m of modules) {
    if (!knownModules.includes(m.name)) throw new Error(`unknown module ${m.name}`);
    const claim = (id: string, wantPublic: boolean) => {
      const op = operations.get(id);
      if (!op) throw new Error(`module ${m.name} has a handler for ${id}, which is not in the specification`);
      if (op.module !== m.name) throw new Error(`${id} belongs to module ${op.module}, not ${m.name}`);
      if (op.isPublic !== wantPublic) throw new Error(`${id} is ${op.isPublic ? 'public' : 'protected'}; register it accordingly`);
    };
    for (const [id, handler] of Object.entries(m.handlers ?? {})) {
      claim(id, false);
      handlers.set(id, handler);
    }
    for (const [id, handler] of Object.entries(m.publicHandlers ?? {})) {
      claim(id, true);
      publicHandlers.set(id, handler);
    }
    for (const r of m.resolvers ?? []) {
      if (resolvers.has(r.type)) throw new Error(`two modules resolve ${r.type}`);
      resolvers.set(r.type, r);
    }
  }

  for (const op of spec.operations) {
    if (!knownModules.includes(op.module)) throw new Error(`${op.operationId} is tagged with unknown module "${op.module}"`);
    if (!op.isPublic && op.permission === null) {
      throw new Error(`${op.operationId} is neither public nor declares x-domesday-permission: refusing to start`);
    }
    for (const ref of op.objects) {
      if (!resolvers.has(ref.type)) throw new Error(`${op.operationId} checks a ${ref.type}, but no module resolves that type`);
    }
  }
  return { handlers, publicHandlers, resolvers };
}

function send(reply: FastifyReply, result: OperationResult, requestId: string, replayed = false): FastifyReply {
  reply.code(result.status);
  for (const [name, value] of Object.entries(result.headers ?? {})) reply.header(name, value);
  if (replayed) reply.header('idempotent-replayed', 'true');
  if (result.status >= 400) {
    reply.type(PROBLEM_CONTENT_TYPE);
    const body = result.body as Record<string, unknown> | undefined;
    return reply.send(body && !('requestId' in body) ? { ...body, requestId } : body);
  }
  return reply.send(result.body ?? null);
}

/**
 * Registers every operation in the specification, and only those. Each route goes
 * through the same layers: rate limit, authentication and permission, the
 * Idempotency-Key check, validation against the specification, object-level
 * authorisation inside the tenant's transaction, then the module's handler, or a
 * typed 501 when the operation is not built yet.
 */
export function registerOperations(app: FastifyInstance, options: RegisterOptions): void {
  const { spec, validators, db, authenticator, policy, idempotency } = options;
  const registry = buildRegistry(spec, options.modules, options.knownModules);

  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === 'body' ? validators.body : validators.text).compile(schema as object));

  for (const op of spec.operations) {
    app.route({
      method: op.method.toUpperCase() as HTTPMethods,
      url: `${spec.basePath}${op.routePath}`,
      schema: {
        ...(op.schemas.params ? { params: op.schemas.params } : {}),
        ...(op.schemas.querystring ? { querystring: op.schemas.querystring } : {}),
        ...(op.schemas.headers ? { headers: op.schemas.headers } : {}),
        ...(op.schemas.body ? { body: op.schemas.body } : {}),
      },
      config: {
        operation: op,
        ...(op.isPublic ? { rateLimit: { max: options.publicRateLimitPerMinute, timeWindow: '1 minute' } } : {}),
      },
      // Authentication, MFA and permission run before the body is read or validated.
      preParsing: async (request: FastifyRequest, _reply: FastifyReply, payload) => {
        request.principal = await authenticateRequest(op, request.headers, authenticator, policy);
        return payload;
      },
      preValidation: async (request: FastifyRequest) => {
        if (op.isWrite && !request.headers['idempotency-key']) {
          throw new ApiError(400, 'idempotency_key_required', 'Every write needs an Idempotency-Key header.');
        }
      },
      handler: async (request, reply) => {
        const requestId = request.id;
        const now = options.now();
        const params = (request.params ?? {}) as Record<string, string>;
        const query = (request.query ?? {}) as Record<string, unknown>;
        const body = request.body;

        if (op.isPublic) {
          const handler = registry.publicHandlers.get(op.operationId);
          const result = handler ? await handler({ operation: op, params, query, body, requestId, now }) : notImplemented(op, requestId);
          return send(reply, result, requestId);
        }

        const principal = request.principal;
        if (!principal) throw new ApiError(401, 'unauthenticated', 'Sign in to use this API.');
        const permission = op.permission as string;

        const outcome = await db.withTenant(principal.tenantId, async (tx) => {
          const objects = await authoriseObjects(tx, op, principal, { params, query, body }, registry.resolvers, policy);
          const handler = registry.handlers.get(op.operationId);
          if (!handler) return { result: notImplemented(op, requestId), replayed: false };

          let key: string | null = null;
          if (op.isWrite) {
            key = String(request.headers['idempotency-key']);
            const claim = await idempotency.claim(tx, {
              tenantId: principal.tenantId,
              key,
              requestHash: requestHash({ method: op.method, route: op.path, principalId: principal.userId, params, body }),
              method: op.method,
              route: op.path,
            });
            if (claim.state === 'replay') return { result: claim.response, replayed: true };
            if (claim.state === 'mismatch') {
              throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request.');
            }
            if (claim.state === 'in_progress') {
              throw new ApiError(409, 'idempotency_request_in_progress', 'A request with this Idempotency-Key is still being handled.');
            }
          }

          const result = await handler({
            operation: op,
            principal,
            tx,
            params,
            query,
            body,
            requestId,
            idempotencyKey: key,
            now,
            objects,
            access: {
              canAccessSite: (siteId) => policy.canAccessSite(principal, permission, siteId),
              sitesInScope: () => policy.sitesInScope(principal, permission),
            },
          });
          if (result.status >= 500) throw new Error(`${op.operationId} returned status ${result.status}`);
          if (key !== null) {
            await idempotency.complete(tx, { tenantId: principal.tenantId, key, response: { status: result.status, body: result.body } });
          }
          return { result, replayed: false };
        });
        return send(reply, outcome.result, requestId, outcome.replayed);
      },
    });
  }
}

/** One error format for everything, including Fastify's own errors. Internals never leak (OWASP A10). */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: Error & { validation?: unknown; validationContext?: string; code?: string; statusCode?: number }, request, reply) => {
    const requestId = request.id;
    const respond = (status: number, body: object, headers: Record<string, string> = {}) => {
      for (const [k, v] of Object.entries(headers)) reply.header(k, v);
      return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(body);
    };
    if (error instanceof ApiError) {
      return respond(error.status, error.toProblem(requestId), error.code === 'unauthenticated' ? { 'www-authenticate': 'Bearer' } : {});
    }
    if (Array.isArray(error.validation)) {
      const errors = (error.validation as { instancePath?: string; message?: string; params?: Record<string, unknown> }[]).map((v) => ({
        in: error.validationContext ?? 'request',
        path: v.instancePath && v.instancePath.length > 0 ? v.instancePath : '/',
        message: v.message ?? 'is not valid',
        ...(v.params ? { details: v.params } : {}),
      }));
      return respond(400, problem(400, 'validation_failed', 'The request does not match the API specification.', { requestId, errors }));
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return respond(415, problem(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.', { requestId }));
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return respond(413, problem(413, 'payload_too_large', 'The request body is too large.', { requestId }));
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return respond(400, problem(400, 'malformed_request', 'The request could not be read.', { requestId }));
    }
    request.log.error({ err: error }, 'unhandled error');
    return respond(500, problem(500, 'internal_error', 'Something went wrong. Quote the request ID if you contact support.', { requestId }));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(404, 'not_found', `There is no route ${request.method} ${request.url.split('?')[0]}.`, { requestId: request.id })),
  );
}
