import pg from 'pg';

/** What handlers use to run SQL. Always inside a transaction scoped to one tenant. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface Database {
  /**
   * Runs fn in one transaction as the application role, with app.tenant_id set so
   * row-level security applies (ADR-DMS-01). A thrown error rolls back; a returned
   * value commits.
   */
  withTenant<T>(tenantId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const APP_ROLE = 'domesday_app';

/** Setting the role and tenant at the start of every transaction. */
export async function enterTenant(tx: Queryable, tenantId: string, role: string = APP_ROLE): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('invalid role name');
  await tx.query(`SET LOCAL ROLE ${role}`);
  await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

export interface PgDatabaseOptions {
  readonly connectionString: string;
  readonly appRole?: string;
  /** Every remote call has a timeout (playbook practice 3). */
  readonly statementTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly maxConnections?: number;
}

export function createPgDatabase(options: PgDatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    max: options.maxConnections ?? 10,
  });
  return {
    async withTenant(tenantId, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Queryable = {
          query: async <R>(sql: string, params?: readonly unknown[]) =>
            (await client.query(sql, params as unknown[])) as unknown as { rows: R[] },
        };
        await enterTenant(tx, tenantId, options.appRole);
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
