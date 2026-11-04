import { createHash, randomUUID } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAiGatewayModule } from './modules/ai-gateway/index';
import { createAssetsModule } from './modules/assets/index';
import { createBillingModule } from './modules/billing/index';
import { createCaptureModule } from './modules/capture/index';
import { createComparisonModule } from './modules/comparison/index';
import { createEvidenceModule } from './modules/evidence/index';
import { createNotificationsModule } from './modules/notifications/index';
import { DEFAULT_MODEL_VERSIONS, createProcessingModule } from './modules/processing/index';
import { createReconciliationModule } from './modules/reconciliation/index';
import { createRegisterModule } from './modules/register/index';
import { createReportsModule } from './modules/reports/index';
import { createReviewModule } from './modules/review/index';
import { createSitesModule } from './modules/sites/index';
import { createTenancyAccessModule } from './modules/tenancy-access/index';
import type { Authenticator } from './platform/authz';
import type { Database } from './platform/db';
import { ApiError } from './platform/errors';
import { createHealthModule } from './platform/health';
import { postgresIdempotencyStore } from './platform/idempotency';
import type { ObjectStore } from './platform/object-store';
import { createValidators, loadSpec } from './platform/openapi';
import { installErrorHandling, registerOperations } from './platform/register';

/** The modules in PRD Part 6, one folder each under src/modules. */
export const MODULE_NAMES = [
  'tenancy-access',
  'sites',
  'register',
  'capture',
  'processing',
  'review',
  'assets',
  'reconciliation',
  'comparison',
  'reports',
  'evidence',
  'notifications',
  'billing',
  'ai-gateway',
] as const;

export interface AppDependencies {
  readonly db: Database;
  readonly objectStore: ObjectStore;
  readonly authenticator: Authenticator;
  readonly now?: () => Date;
  readonly logger?: boolean;
  readonly version?: string;
  /** Per client, per minute, on every route (DMS-157). */
  readonly rateLimitPerMinute?: number;
  readonly publicRateLimitPerMinute?: number;
  readonly modelVersions?: Readonly<Record<string, string>>;
}

/** Rate limits key on the caller's token when there is one, otherwise the address. */
function clientKey(request: { headers: Record<string, unknown>; ip: string }): string {
  const auth = request.headers.authorization;
  return typeof auth === 'string' ? `token:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}` : `ip:${request.ip}`;
}

/** The composition root: the only place that knows every module. */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024 });
  installErrorHandling(app);
  await app.register(rateLimit, {
    global: true,
    max: deps.rateLimitPerMinute ?? 600,
    timeWindow: '1 minute',
    keyGenerator: clientKey,
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, 'rate_limited', `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`),
  });

  const spec = loadSpec();
  const tenancy = createTenancyAccessModule();
  const evidence = createEvidenceModule();
  const processing = createProcessingModule({ modelVersions: deps.modelVersions ?? DEFAULT_MODEL_VERSIONS });
  const capture = createCaptureModule({
    objectStore: deps.objectStore,
    evidence: evidence.api,
    tenancy: tenancy.api,
    processing: processing.api,
  });

  registerOperations(app, {
    spec,
    validators: createValidators(spec),
    modules: [
      createHealthModule(deps.version ?? '0.1.0'),
      tenancy.definition,
      createSitesModule().definition,
      createRegisterModule().definition,
      capture.definition,
      processing.definition,
      createReviewModule().definition,
      createAssetsModule().definition,
      createReconciliationModule().definition,
      createComparisonModule().definition,
      createReportsModule().definition,
      evidence.definition,
      createNotificationsModule().definition,
      createBillingModule().definition,
      createAiGatewayModule().definition,
    ],
    knownModules: ['platform', ...MODULE_NAMES],
    db: deps.db,
    authenticator: deps.authenticator,
    policy: tenancy.policy,
    idempotency: postgresIdempotencyStore,
    now: deps.now ?? (() => new Date()),
    publicRateLimitPerMinute: deps.publicRateLimitPerMinute ?? 30,
  });
  return app;
}
