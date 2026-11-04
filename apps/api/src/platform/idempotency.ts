import { createHash } from 'node:crypto';
import type { Queryable } from './db';

/**
 * Every write takes an Idempotency-Key (Part 6; playbook practice 3, after Stripe).
 * The key is claimed in the same transaction as the write, so the stored response
 * and the change commit or roll back together.
 */
export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ClaimResult =
  | { readonly state: 'new' }
  | { readonly state: 'replay'; readonly response: StoredResponse }
  | { readonly state: 'mismatch' }
  | { readonly state: 'in_progress' };

export interface IdempotencyStore {
  claim(tx: Queryable, input: { tenantId: string; key: string; requestHash: string; method: string; route: string }): Promise<ClaimResult>;
  complete(tx: Queryable, input: { tenantId: string; key: string; response: StoredResponse }): Promise<void>;
}

/** JSON with object keys sorted, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Same key with a different method, route, caller or body is a different request. */
export function requestHash(input: { method: string; route: string; principalId: string; params: unknown; body: unknown }): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export const postgresIdempotencyStore: IdempotencyStore = {
  async claim(tx, input) {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, method, route)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING key`,
      [input.tenantId, input.key, input.requestHash, input.method, input.route],
    );
    if (inserted.rows.length === 1) return { state: 'new' };
    const { rows } = await tx.query<{ request_hash: string; status: string; response_status: number | null; response_body: unknown }>(
      'SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE tenant_id = $1 AND key = $2',
      [input.tenantId, input.key],
    );
    const existing = rows[0];
    if (!existing || existing.request_hash !== input.requestHash) return { state: 'mismatch' };
    if (existing.status !== 'completed' || existing.response_status === null) return { state: 'in_progress' };
    return { state: 'replay', response: { status: existing.response_status, body: existing.response_body } };
  },

  async complete(tx, input) {
    await tx.query(
      `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4, completed_at = now()
       WHERE tenant_id = $1 AND key = $2`,
      [input.tenantId, input.key, input.response.status, JSON.stringify(input.response.body ?? null)],
    );
  },
};
