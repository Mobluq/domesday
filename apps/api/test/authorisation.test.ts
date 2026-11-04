import { randomUUID } from 'node:crypto';
import { ROLE_PERMISSIONS } from '@domesday/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSpec, type OperationSpec } from '../src/platform/openapi';
import { createTestApp, expectContract, newKey, type TestApp } from './helpers';

const spec = loadSpec();
const urlOf = (op: OperationSpec, values: Record<string, string> = {}): string =>
  `${spec.basePath}${op.path.replace(/\{([^}]+)\}/g, (_, name: string) => values[name] ?? randomUUID())}`;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

describe('platform', () => {
  it('GET /v1/health answers without signing in, as the specification says', async () => {
    const response = await t.request({ method: 'GET', url: '/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'domesday-api' });
    expectContract('getHealth', response);
  });

  it('an unknown route gets the one problem format', async () => {
    const response = await t.request({ method: 'GET', url: '/v1/nowhere' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found', status: 404 });
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});

describe('one shared authorisation layer on every route', () => {
  const protectedOps = spec.operations.filter((o) => !o.isPublic);

  it(`all ${protectedOps.length} protected operations refuse an anonymous caller with 401`, async () => {
    for (const op of protectedOps) {
      const response = await t.request({ method: op.method.toUpperCase() as 'GET', url: urlOf(op), idempotencyKey: newKey() });
      expect(response.statusCode, `${op.method} ${op.path}`).toBe(401);
      expect(response.json().code).toBe('unauthenticated');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('every operation whose permission the read-only role lacks refuses it with 403, before reading the body', async () => {
    const readOnly = new Set<string>(ROLE_PERMISSIONS.read_only);
    const refused = protectedOps.filter((o) => !readOnly.has(o.permission as string));
    expect(refused.length).toBeGreaterThan(30);
    for (const op of refused) {
      const response = await t.request({
        method: op.method.toUpperCase() as 'GET',
        url: urlOf(op),
        token: t.tokens.readOnlyA,
        idempotencyKey: newKey(),
        payload: op.schemas.body ? '{"not":"valid"}' : undefined,
        headers: op.schemas.body ? { 'content-type': 'application/json' } : {},
      });
      expect(response.statusCode, `${op.operationId}`).toBe(403);
      expect(response.json().code).toBe('forbidden');
    }
  });

  it('DMS-130: an administrator without MFA is stopped before reaching any data', async () => {
    const response = await t.request({ method: 'GET', url: '/v1/me', token: t.tokens.adminNoMfaA });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('mfa_required');
    const withMfa = await t.request({ method: 'GET', url: '/v1/me', token: t.tokens.adminA });
    expect(withMfa.statusCode).toBe(200);
  });

  it('DMS-131: a site manager who opens another site\'s walk is refused', async () => {
    const response = await t.request({ method: 'GET', url: `/v1/walks/${t.ids.walkA2}`, token: t.tokens.siteManagerA1 });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
    expectContract('getWalk', response);
  });

  it('another tenant\'s objects do not exist as far as the caller can tell (row-level security)', async () => {
    const response = await t.request({ method: 'GET', url: `/v1/walks/${t.ids.walkA1}`, token: t.tokens.userB });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });

  it('object checks cover IDs in the body too: a walk cannot be created on a site outside the caller\'s scope', async () => {
    const response = await t.request({
      method: 'POST',
      url: '/v1/walks',
      token: t.tokens.siteManagerA1,
      idempotencyKey: newKey(),
      payload: { id: randomUUID(), siteId: t.ids.siteA2, startedAtDevice: new Date().toISOString() },
    });
    expect(response.statusCode).toBe(403);
  });

  it('once authorised, an operation that is not built yet answers with a typed 501', async () => {
    const response = await t.request({ method: 'GET', url: `/v1/walks/${t.ids.walkA1}`, token: t.tokens.siteManagerA1 });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ code: 'not_implemented', operationId: 'getWalk', module: 'capture' });
    expectContract('getWalk', response);
  });

  it('GET /v1/me describes the caller, matching the specification', async () => {
    const response = await t.request({ method: 'GET', url: '/v1/me', token: t.tokens.siteManagerA1 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ userId: t.ids.users.siteManagerA1, grants: [{ role: 'site_manager', sites: [t.ids.siteA1] }] });
    expectContract('getCurrentPrincipal', response);
  });
});

describe('input is validated against the specification', () => {
  const confirmUrl = (clipId: string) => `/v1/clips/${clipId}/confirm`;

  it('refuses a write without an Idempotency-Key', async () => {
    const response = await t.request({
      method: 'POST',
      url: confirmUrl(randomUUID()),
      token: t.tokens.siteManagerA1,
      payload: { sha256: 'a'.repeat(64), deviceTime: new Date().toISOString(), parts: [{ partNumber: 1, etag: 'x' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('idempotency_key_required');
  });

  it('refuses a malformed path ID, fingerprint, unknown field or out-of-range limit, saying where', async () => {
    const badPath = await t.request({ method: 'GET', url: '/v1/walks/not-a-uuid', token: t.tokens.siteManagerA1 });
    expect(badPath.statusCode).toBe(400);
    expect(badPath.json()).toMatchObject({ code: 'validation_failed', errors: [{ in: 'params' }] });

    const badHash = await t.request({
      method: 'POST',
      url: confirmUrl(randomUUID()),
      token: t.tokens.siteManagerA1,
      idempotencyKey: newKey(),
      payload: { sha256: 'NOT-A-HASH', deviceTime: new Date().toISOString(), parts: [{ partNumber: 1, etag: 'x' }] },
    });
    expect(badHash.statusCode).toBe(400);
    expect(badHash.json().errors[0]).toMatchObject({ in: 'body', path: '/sha256' });

    const extra = await t.request({
      method: 'POST',
      url: confirmUrl(randomUUID()),
      token: t.tokens.siteManagerA1,
      idempotencyKey: newKey(),
      payload: { sha256: 'a'.repeat(64), deviceTime: new Date().toISOString(), parts: [{ partNumber: 1, etag: 'x' }], userId: 'someone' },
    });
    expect(extra.statusCode).toBe(400);

    const limit = await t.request({ method: 'GET', url: '/v1/audit-events?limit=500', token: t.tokens.auditorA });
    expect(limit.statusCode).toBe(400);
    expect(limit.json().errors[0]).toMatchObject({ in: 'querystring' });
  });

  it('refuses invalid JSON with the problem format, never a stack trace', async () => {
    const response = await t.request({
      method: 'POST',
      url: confirmUrl(randomUUID()),
      token: t.tokens.siteManagerA1,
      idempotencyKey: newKey(),
      headers: { 'content-type': 'application/json' },
      payload: '{"sha256": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('malformed_request');
    expect(response.body).not.toMatch(/at .*\.ts:\d+/);
  });

  it('DMS-058 at the boundary: a skipped room needs a reason before any handler runs', async () => {
    const response = await t.request({
      method: 'PUT',
      url: `/v1/walks/${t.ids.walkA1}/rooms/${t.ids.roomA1}/status`,
      token: t.tokens.siteManagerA1,
      idempotencyKey: newKey(),
      payload: { status: 'skipped' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('DMS-157: every route is rate limited per client', () => {
  it('refuses the request over the limit with rate_limited', async () => {
    const limited = await createTestApp({ rateLimitPerMinute: 3 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        statuses.push((await limited.request({ method: 'GET', url: '/v1/me', token: limited.tokens.siteManagerA1 })).statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
      const over = await limited.request({ method: 'GET', url: '/v1/me', token: limited.tokens.siteManagerA1 });
      expect(over.json()).toMatchObject({ code: 'rate_limited', status: 429 });
      // Another client has its own allowance.
      expect((await limited.request({ method: 'GET', url: '/v1/me', token: limited.tokens.auditorA })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
