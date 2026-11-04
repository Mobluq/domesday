import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two calls the runner needs. A PGlite instance already has this shape;
 * wrap a node-postgres client with fromPg().
 */
export interface SqlClient {
  /** Runs one or more statements with no parameters. */
  exec(sql: string): Promise<unknown>;
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** Adapts a node-postgres client (or pool client). With no parameters pg runs several statements at once. */
export function fromPg(client: {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}): SqlClient {
  return {
    exec: (sql) => client.query(sql),
    query: async <R>(sql: string, params?: unknown[]) => (await client.query(sql, params)) as { rows: R[] },
  };
}

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string | null;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

const UP_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const DOWN_FILE = /^(\d{4})_([a-z0-9_]+)\.down\.sql$/;
// Any fixed number will do: it keeps two runners from migrating the same database at once.
const LOCK_KEY = 727_274_001;

/** Numbered files: 0001_name.sql with an optional 0001_name.down.sql beside it. */
export async function listMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).sort();
  const downs = new Map<string, string>();
  for (const n of names) {
    const m = DOWN_FILE.exec(n);
    if (m) downs.set(`${m[1]}_${m[2]}`, join(dir, n));
  }
  const files: MigrationFile[] = [];
  const versions = new Set<string>();
  for (const n of names) {
    const m = UP_FILE.exec(n);
    if (!m || n.endsWith('.down.sql')) continue;
    const [, version, name] = m as unknown as [string, string, string];
    if (versions.has(version)) throw new MigrationError(`two migrations share version ${version}`);
    versions.add(version);
    files.push({ version, name, upPath: join(dir, n), downPath: downs.get(`${version}_${name}`) ?? null });
  }
  return files;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function ensureBookkeeping(client: SqlClient): Promise<void> {
  // Kept in its own schema so that every table in public is a tenant table.
  await client.exec(`
    CREATE SCHEMA IF NOT EXISTS meta;
    CREATE TABLE IF NOT EXISTS meta.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function applied(client: SqlClient): Promise<Map<string, { name: string; checksum: string }>> {
  const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM meta.schema_migrations ORDER BY version',
  );
  return new Map(rows.map((r) => [r.version, { name: r.name, checksum: r.checksum }]));
}

async function withLock<T>(client: SqlClient, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

async function inTransaction(client: SqlClient, label: string, fn: () => Promise<void>): Promise<void> {
  await client.exec('BEGIN');
  try {
    await fn();
    await client.exec('COMMIT');
  } catch (error) {
    await client.exec('ROLLBACK');
    const message = error instanceof Error ? error.message : String(error);
    throw new MigrationError(`${label} failed: ${message}`, { cause: error });
  }
}

export interface RunOptions {
  readonly dir?: string;
  readonly log?: (line: string) => void;
}

/** Apply every migration not yet applied, each in its own transaction. Refuses if an applied file has changed. */
export async function migrate(client: SqlClient, options: RunOptions = {}): Promise<{ applied: string[] }> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);
  await ensureBookkeeping(client);
  return withLock(client, async () => {
    const done = await applied(client);
    const files = await listMigrations(dir);
    const appliedNow: string[] = [];
    for (const file of files) {
      const sql = await readFile(file.upPath, 'utf8');
      const label = `${file.version}_${file.name}`;
      const previous = done.get(file.version);
      if (previous) {
        if (previous.checksum !== checksum(sql)) {
          throw new MigrationError(`${label} was changed after it was applied; add a new migration instead (expand and contract)`);
        }
        continue;
      }
      await inTransaction(client, label, async () => {
        await client.exec(sql);
        await client.query('INSERT INTO meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          file.version,
          file.name,
          checksum(sql),
        ]);
      });
      appliedNow.push(label);
      log(`applied ${label}`);
    }
    return { applied: appliedNow };
  });
}

/** Revert the most recently applied migrations using their .down.sql files. */
export async function rollback(
  client: SqlClient,
  options: RunOptions & { readonly steps?: number } = {},
): Promise<{ reverted: string[] }> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);
  const steps = options.steps ?? 1;
  await ensureBookkeeping(client);
  return withLock(client, async () => {
    const done = [...(await applied(client)).keys()].sort().reverse().slice(0, steps);
    const files = new Map((await listMigrations(dir)).map((f) => [f.version, f]));
    const reverted: string[] = [];
    for (const version of done) {
      const file = files.get(version);
      if (!file?.downPath) throw new MigrationError(`migration ${version} has no .down.sql file`);
      const label = `${file.version}_${file.name}`;
      const sql = await readFile(file.downPath, 'utf8');
      await inTransaction(client, `${label} (down)`, async () => {
        await client.exec(sql);
        await client.query('DELETE FROM meta.schema_migrations WHERE version = $1', [version]);
      });
      reverted.push(label);
      log(`reverted ${label}`);
    }
    return { reverted };
  });
}

export async function migrationStatus(
  client: SqlClient,
  dir: string = MIGRATIONS_DIR,
): Promise<{ version: string; name: string; applied: boolean }[]> {
  await ensureBookkeeping(client);
  const done = await applied(client);
  return (await listMigrations(dir)).map((f) => ({ version: f.version, name: f.name, applied: done.has(f.version) }));
}
