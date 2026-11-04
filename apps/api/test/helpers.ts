import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fromPg, migrate } from '@domesday/db';
import type { RoleGrant } from '@domesday/domain';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { expect } from 'vitest';
import { buildApp, type AppDependencies } from '../src/app';
import { StaticTokenAuthenticator } from '../src/modules/tenancy-access/index';
import type { Principal } from '../src/platform/authz';
import { createPgDatabase, enterTenant, type Database, type Queryable } from '../src/platform/db';
import { InMemoryObjectStore } from '../src/platform/object-store';
import { compileResponseValidator, createValidators, loadSpec } from '../src/platform/openapi';

/** The API's Database interface over PGlite, with the same role and tenant setup as production. */
export function pgliteDatabase(db: PGlite): Database {
  return {
    withTenant: (tenantId, fn) =>
      db.transaction(async (tx) => {
        const q: Queryable = { query: async <R>(sql: string, params?: readonly unknown[]) => tx.query<R>(sql, params as unknown[]) };
        await enterTenant(q, tenantId);
        return fn(q);
      }),
    close: async () => undefined,
  };
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Runs SQL as the connecting superuser, for seeding and for checking what a test wrote. */
export interface SqlRunner {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * PGlite always. Real PostgreSQL as well when TEST_DATABASE_URL is set: then the
 * app uses the production adapter (createPgDatabase) against a fresh database.
 */
export type Backend = 'PGlite' | 'PostgreSQL';
export const BACKENDS: Backend[] = process.env.TEST_DATABASE_URL ? ['PGlite', 'PostgreSQL'] : ['PGlite'];

interface OpenedBackend {
  readonly sql: SqlRunner;
  readonly database: Database;
  close(): Promise<void>;
}

async function openBackend(backend: Backend): Promise<OpenedBackend> {
  if (backend === 'PGlite') {
    const db = new PGlite();
    await migrate(db);
    return {
      sql: { query: async <R>(text: string, params?: unknown[]) => db.query<R>(text, params) },
      database: pgliteDatabase(db),
      close: () => db.close(),
    };
  }
  const adminUrl = process.env.TEST_DATABASE_URL as string;
  const name = `domesday_api_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await migrate(fromPg(client));
  const database = createPgDatabase({ connectionString: url.toString(), maxConnections: 4 });
  return {
    sql: { query: async <R>(text: string, params?: unknown[]) => (await client.query(text, params)) as unknown as { rows: R[] } },
    database,
    close: async () => {
      await database.close();
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

const id = (): string => randomUUID();

/** Two tenants with sites, rooms, walks and users in every role the tests need. */
export function fixtureIds() {
  return {
    tenantA: id(),
    tenantB: id(),
    siteA1: id(),
    siteA2: id(),
    siteB1: id(),
    roomA1: id(),
    roomA2: id(),
    roomB1: id(),
    walkA1: id(),
    walkA2: id(),
    walkB1: id(),
    users: {
      siteManagerA1: id(),
      siteManagerA2: id(),
      readOnlyA: id(),
      auditorA: id(),
      adminA: id(),
      adminNoMfaA: id(),
      userB: id(),
    },
  };
}
export type FixtureIds = ReturnType<typeof fixtureIds>;

async function seed(db: SqlRunner, ids: FixtureIds): Promise<void> {
  const tenants: [string, string][] = [
    [ids.tenantA, 'Tenant A'],
    [ids.tenantB, 'Tenant B'],
  ];
  for (const [tenantId, name] of tenants) await db.query('INSERT INTO tenants (tenant_id, name) VALUES ($1, $2)', [tenantId, name]);
  const users: [string, string][] = [
    ...Object.entries(ids.users)
      .filter(([k]) => k !== 'userB')
      .map(([, u]) => [u, ids.tenantA] as [string, string]),
    [ids.users.userB, ids.tenantB],
  ];
  for (const [userId, tenantId] of users) {
    await db.query("INSERT INTO users (id, tenant_id, auth_subject, display_name, email) VALUES ($1, $2, $3, 'Test user', 'user@example.com')", [
      userId,
      tenantId,
      `auth|${userId}`,
    ]);
  }
  const sites: [string, string, string, string][] = [
    [ids.siteA1, ids.tenantA, ids.roomA1, ids.walkA1],
    [ids.siteA2, ids.tenantA, ids.roomA2, ids.walkA2],
    [ids.siteB1, ids.tenantB, ids.roomB1, ids.walkB1],
  ];
  for (const [siteId, tenantId, roomId, walkId] of sites) {
    const starter = tenantId === ids.tenantA ? ids.users.siteManagerA1 : ids.users.userB;
    await db.query("INSERT INTO sites (id, tenant_id, name) VALUES ($1, $2, 'Site')", [siteId, tenantId]);
    await db.query("INSERT INTO rooms (id, tenant_id, site_id, name) VALUES ($1, $2, $3, 'Room 1')", [roomId, tenantId, siteId]);
    await db.query('INSERT INTO walks (id, tenant_id, site_id, started_by, started_at_device) VALUES ($1, $2, $3, $4, now())', [
      walkId,
      tenantId,
      siteId,
      starter,
    ]);
  }
}

export interface TestApp {
  readonly app: FastifyInstance;
  readonly backend: Backend;
  /** Superuser SQL, which row-level security does not apply to. */
  readonly db: SqlRunner;
  readonly store: InMemoryObjectStore;
  readonly ids: FixtureIds;
  /** Bearer tokens by persona. */
  readonly tokens: Record<
    'siteManagerA1' | 'siteManagerA2' | 'readOnlyA' | 'auditorA' | 'adminA' | 'adminNoMfaA' | 'userB',
    string
  >;
  request(options: InjectOptions & { token?: string; idempotencyKey?: string }): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Partial<AppDependencies> = {}, backend: Backend = 'PGlite'): Promise<TestApp> {
  const opened = await openBackend(backend);
  const db = opened.sql;
  const ids = fixtureIds();
  await seed(db, ids);

  const principal = (userId: string, tenantId: string, grants: RoleGrant[], mfaVerified = false): Principal => ({
    userId,
    tenantId,
    displayName: 'Test user',
    kind: 'user',
    grants,
    mfaVerified,
  });
  const tokens = {
    siteManagerA1: 'token-site-manager-a1',
    siteManagerA2: 'token-site-manager-a2',
    readOnlyA: 'token-read-only-a',
    auditorA: 'token-auditor-a',
    adminA: 'token-admin-a',
    adminNoMfaA: 'token-admin-no-mfa-a',
    userB: 'token-user-b',
  };
  const authenticator = new StaticTokenAuthenticator({
    [tokens.siteManagerA1]: principal(ids.users.siteManagerA1, ids.tenantA, [{ role: 'site_manager', sites: [ids.siteA1] }]),
    [tokens.siteManagerA2]: principal(ids.users.siteManagerA2, ids.tenantA, [{ role: 'site_manager', sites: [ids.siteA2] }]),
    [tokens.readOnlyA]: principal(ids.users.readOnlyA, ids.tenantA, [{ role: 'read_only', sites: 'all' }]),
    [tokens.auditorA]: principal(ids.users.auditorA, ids.tenantA, [{ role: 'internal_auditor', sites: 'all' }]),
    [tokens.adminA]: principal(ids.users.adminA, ids.tenantA, [{ role: 'tenant_administrator', sites: 'all' }], true),
    [tokens.adminNoMfaA]: principal(ids.users.adminNoMfaA, ids.tenantA, [{ role: 'tenant_administrator', sites: 'all' }], false),
    [tokens.userB]: principal(ids.users.userB, ids.tenantB, [{ role: 'facilities_manager', sites: 'all' }]),
  });

  const store = new InMemoryObjectStore();
  const app = await buildApp({ db: opened.database, objectStore: store, authenticator, ...overrides });
  await app.ready();

  return {
    app,
    backend,
    db,
    store,
    ids,
    tokens,
    request: ({ token, idempotencyKey, headers, ...options }) =>
      app.inject({
        ...options,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
          ...(headers ?? {}),
        },
      }),
    close: async () => {
      await app.close();
      await opened.close();
    },
  };
}

const spec = loadSpec();
const validators = createValidators(spec);

/** Checks a response against the specification: the documented status, or the default problem response. */
export function expectContract(operationId: string, response: LightMyRequestResponse): void {
  const op = spec.operations.find((o) => o.operationId === operationId);
  if (!op) throw new Error(`unknown operation ${operationId}`);
  const status = String(response.statusCode);
  const schema = op.responses[status] ?? op.responses.default;
  expect(schema, `${operationId} documents ${status} or a default`).toBeDefined();
  const validate = compileResponseValidator(validators, schema as Record<string, never>);
  const body: unknown = response.json();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['content-type']).toContain(response.statusCode >= 400 ? 'application/problem+json' : 'application/json');
}

export function randomClip(size: number): Uint8Array {
  return new Uint8Array(randomBytes(size));
}

export function newKey(): string {
  return `key-${randomUUID()}`;
}
