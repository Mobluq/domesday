import { ApiError } from './errors';

/**
 * Cursor pagination for every list (DMS-157). A cursor is opaque to clients:
 * base64url JSON holding the sort key of the last item returned.
 */
export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function encodeCursor(position: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...position }), 'utf8').toString('base64url');
}

/**
 * Reads a cursor, checking every expected field with its validator. A tampered or
 * foreign cursor is refused before any of it reaches SQL.
 */
export function decodeCursor<K extends string>(cursor: string, fields: Readonly<Record<K, (value: string) => boolean>>): Record<K, string> {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1) throw new Error('version');
    const out = {} as Record<K, string>;
    for (const key of Object.keys(fields) as K[]) {
      const v = value[key];
      if (typeof v !== 'string' || v.length === 0 || v.length > 200 || !fields[key](v)) throw new Error(key);
      out[key] = v;
    }
    return out;
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid for this list. Start again without a cursor.');
  }
}

export const isUuidText = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const isTimestampText = (v: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v);

/** The limit query parameter, already validated against the specification (1 to 200). */
export function limitOf(query: Readonly<Record<string, unknown>>): number {
  const n = Number(query.limit ?? DEFAULT_LIMIT);
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : DEFAULT_LIMIT;
}

/** Fetch limit + 1 rows; this trims the extra row and sets nextCursor when there are more. */
export function toPage<R, T>(rows: readonly R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => string): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return { items: pageRows.map(map), nextCursor: hasMore && last !== undefined ? cursorOf(last) : null };
}
