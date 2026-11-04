import type { AuditAction } from '@domesday/domain';
import type { Queryable } from '../../platform/db';
import { ApiError } from '../../platform/errors';
import { ok, type OperationHandler } from '../../platform/operation';
import { decodeCursor, encodeCursor, isTimestampText, isUuidText, limitOf, toPage } from '../../platform/pagination';

export interface AuditEventInput {
  readonly actorKind: 'user' | 'partner' | 'managed_review' | 'service' | 'system';
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly requestId?: string | null;
}

/** Microsecond precision, so keyset pagination never skips or repeats events in the same millisecond. */
const AT_TEXT = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));

/** DMS-092: append one event to the audit log. The database sets the time and refuses any later change. */
export async function appendAuditEvent(tx: Queryable, tenantId: string, event: AuditEventInput): Promise<{ id: string; at: string }> {
  const { rows } = await tx.query<{ id: string; at: string }>(
    `INSERT INTO audit_events (tenant_id, actor_kind, actor_user_id, action, object_type, object_id, before, after, reason, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, ${AT_TEXT} AS at`,
    [
      tenantId,
      event.actorKind,
      event.actorUserId,
      event.action,
      event.objectType,
      event.objectId,
      json(event.before),
      json(event.after),
      event.reason ?? null,
      event.requestId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('audit event was not recorded');
  return row;
}

interface AuditRow {
  id: string;
  actor_kind: string;
  actor_user_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  request_id: string | null;
  at: string;
}

/** DMS-092: the audit log, newest first, with cursor pagination (DMS-157). */
export const listAuditEvents: OperationHandler = async (ctx) => {
  // The log covers the whole tenant, so reading it needs a grant over every site.
  if (!ctx.access.canAccessSite(null)) {
    throw new ApiError(403, 'forbidden', 'The audit log covers every site, so reading it needs access to all sites.');
  }
  const limit = limitOf(ctx.query);
  const cursor = typeof ctx.query.cursor === 'string' ? decodeCursor(ctx.query.cursor, { at: isTimestampText, id: isUuidText }) : null;
  const filter = (name: string): string | null => (typeof ctx.query[name] === 'string' ? (ctx.query[name] as string) : null);

  const { rows } = await ctx.tx.query<AuditRow>(
    `SELECT id, actor_kind, actor_user_id, action, object_type, object_id, before, after, reason, request_id, ${AT_TEXT} AS at
     FROM audit_events
     WHERE ($1::text IS NULL OR object_type = $1)
       AND ($2::text IS NULL OR object_id = $2)
       AND ($3::text IS NULL OR action = $3)
       AND ($4::timestamptz IS NULL OR (at, id) < ($4::timestamptz, $5::uuid))
     ORDER BY at DESC, id DESC
     LIMIT $6`,
    [filter('objectType'), filter('objectId'), filter('action'), cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );

  return ok(
    toPage(
      rows,
      limit,
      (r) => ({
        id: r.id,
        actorKind: r.actor_kind,
        actorUserId: r.actor_user_id,
        action: r.action,
        objectType: r.object_type,
        objectId: r.object_id,
        before: r.before ?? null,
        after: r.after ?? null,
        reason: r.reason,
        requestId: r.request_id,
        at: r.at,
      }),
      (r) => encodeCursor({ at: r.at, id: r.id }),
    ),
  );
};
