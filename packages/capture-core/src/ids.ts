/** Returns a new random UUID. On the phone this is expo-crypto's randomUUID; in Node it is crypto.randomUUID. */
export type UuidSource = () => string;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function defaultUuidSource(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID !== 'function') {
    throw new Error('No UUID source available: pass one in (for example expo-crypto randomUUID on the phone)');
  }
  return crypto.randomUUID();
}

/**
 * Part 6 (data model): a clip's ID is a UUID made on the phone. It is the
 * idempotency key, so a retried upload can never create a second clip. Walks and
 * provisional rooms get phone-made IDs the same way, so capture works offline.
 */
export function newPhoneId(source: UuidSource = defaultUuidSource): string {
  const id = source().toLowerCase();
  if (!isUuid(id)) throw new Error(`UUID source returned an invalid UUID: ${id}`);
  return id;
}
