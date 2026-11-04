import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { fromPg, migrate, type SqlClient } from '../src';

/**
 * The same tests run against every backend available:
 * - PGlite (PostgreSQL compiled to WebAssembly), always;
 * - a real PostgreSQL server when TEST_DATABASE_URL is set (CI sets it). Each run
 *   creates a fresh database there and drops it afterwards.
 */
export interface Backend {
  readonly label: string;
  create(): Promise<TestDatabase>;
}

export type Row = Record<string, unknown>;

export interface TestDatabase {
  readonly label: string;
  readonly sql: SqlClient;
  exec(sql: string): Promise<void>;
  rows<R = Row>(sql: string, params?: unknown[]): Promise<R[]>;
  /**
   * Runs fn as the application role (domesday_app) inside a transaction with
   * app.tenant_id set, or unset when tenantId is null. Always rolled back.
   */
  asApp<T>(tenantId: string | null, fn: (q: Query) => Promise<T>, settings?: Record<string, string>): Promise<T>;
  /** Runs fn as the connecting superuser inside a transaction that is always rolled back. */
  asOwner<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type Query = <R = Row>(sql: string, params?: unknown[]) => Promise<R[]>;

function wrap(label: string, sql: SqlClient, close: () => Promise<void>): TestDatabase {
  const rows = async <R>(text: string, params?: unknown[]): Promise<R[]> => (await sql.query<R>(text, params)).rows;
  const sandbox = async <T>(setup: (q: Query) => Promise<void>, fn: (q: Query) => Promise<T>): Promise<T> => {
    await sql.exec('BEGIN');
    try {
      await setup(rows);
      return await fn(rows);
    } finally {
      await sql.exec('ROLLBACK');
    }
  };
  return {
    label,
    sql,
    exec: async (text) => {
      await sql.exec(text);
    },
    rows,
    asApp: (tenantId, fn, settings = {}) =>
      sandbox(async (q) => {
        await q('SET LOCAL ROLE domesday_app');
        if (tenantId !== null) await q("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        for (const [key, value] of Object.entries(settings)) await q('SELECT set_config($1, $2, true)', [key, value]);
      }, fn),
    asOwner: (fn) => sandbox(async () => undefined, fn),
    close,
  };
}

const pglite: Backend = {
  label: 'PGlite',
  async create() {
    const db = new PGlite();
    await migrate(db);
    return wrap('PGlite', db, () => db.close());
  },
};

function postgres(adminUrl: string): Backend {
  return {
    label: 'PostgreSQL',
    async create() {
      const name = `domesday_test_${randomBytes(6).toString('hex')}`;
      const admin = new pg.Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      const sql = fromPg(client);
      await migrate(sql);
      const version = (await sql.query<{ v: string }>('SHOW server_version')).rows[0]?.v ?? '?';
      return wrap(`PostgreSQL ${version}`, sql, async () => {
        await client.end();
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
      });
    },
  };
}

export const backends: Backend[] = [pglite];
if (process.env.TEST_DATABASE_URL) backends.push(postgres(process.env.TEST_DATABASE_URL));

/** Expects the promise to fail with a message matching the pattern. */
export async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failed = false;
  try {
    await promise;
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`failed as expected, but with "${message}" instead of ${pattern}`, { cause: error });
    }
  }
  if (!failed) throw new Error(`expected a failure matching ${pattern}`);
}

/** Seed data, inserted as the owner (superuser), which row-level security does not apply to. */
export async function seedTenant(db: TestDatabase, name: string, kind: 'organisation' | 'partner' = 'organisation') {
  const [tenant] = await db.rows<{ tenant_id: string }>('INSERT INTO tenants (name, kind) VALUES ($1, $2) RETURNING tenant_id', [
    name,
    kind,
  ]);
  const tenantId = tenant!.tenant_id;
  const [user] = await db.rows<{ id: string }>(
    "INSERT INTO users (tenant_id, auth_subject, display_name, email) VALUES ($1, $2, 'Test user', 'user@example.com') RETURNING id",
    [tenantId, `auth|${name}`],
  );
  const [site] = await db.rows<{ id: string }>("INSERT INTO sites (tenant_id, name) VALUES ($1, $2) RETURNING id", [
    tenantId,
    `${name} site`,
  ]);
  const [room] = await db.rows<{ id: string }>("INSERT INTO rooms (tenant_id, site_id, name) VALUES ($1, $2, 'Room 1') RETURNING id", [
    tenantId,
    site!.id,
  ]);
  const [category] = await db.rows<{ id: string }>("INSERT INTO categories (tenant_id, name) VALUES ($1, 'Generator') RETURNING id", [
    tenantId,
  ]);
  return { tenantId, userId: user!.id, siteId: site!.id, roomId: room!.id, categoryId: category!.id };
}

export type SeededTenant = Awaited<ReturnType<typeof seedTenant>>;

export async function seedWalk(db: TestDatabase, t: SeededTenant): Promise<string> {
  const [walk] = await db.rows<{ id: string }>(
    "INSERT INTO walks (id, tenant_id, site_id, started_by, started_at_device) VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id",
    [t.tenantId, t.siteId, t.userId],
  );
  return walk!.id;
}

export async function seedClip(db: TestDatabase, t: SeededTenant, walkId: string): Promise<string> {
  const [clip] = await db.rows<{ id: string }>(
    `INSERT INTO clips (id, tenant_id, walk_id, room_id, site_id, captured_by, device_id, started_at_device,
                        ended_at_device, size_bytes, content_type, staging_key, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'device-1', now() - interval '2 minutes', now() - interval '1 minute',
             1000, 'video/mp4', 'staging/clip', 'uploading')
     RETURNING id`,
    [t.tenantId, walkId, t.roomId, t.siteId, t.userId],
  );
  return clip!.id;
}
