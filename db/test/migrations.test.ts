import { randomUUID } from 'node:crypto';
import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChangeStatus,
  ClipUploadStatus,
  ComparisonMatchMethod,
  ConditionGrade,
  ConfidenceBand,
  InvestigationOutcome,
  InvestigationStatus,
  JobStatus,
  LineKind,
  LineStatus,
  PipelineStage,
  ReconMatchMethod,
  ReconStatus,
  ReportType,
  ReviewDecisionKind,
  Role,
  RoomWalkStatus,
  WalkStatus,
  assessClockGap,
  checkRetentionMonths,
} from '@domesday/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, listMigrations, migrate, rollback } from '../src';
import { backends, refused, seedClip, seedTenant, seedWalk, type Query, type SeededTenant, type TestDatabase } from './harness';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** Runs a statement inside a savepoint and returns the error message, or null if it worked. */
async function attempt(q: Query, sql: string, params?: unknown[]): Promise<string | null> {
  await q('SAVEPOINT attempt');
  try {
    await q(sql, params);
    await q('RELEASE SAVEPOINT attempt');
    return null;
  } catch (error) {
    await q('ROLLBACK TO SAVEPOINT attempt');
    return error instanceof Error ? error.message : String(error);
  }
}

const APPEND_ONLY = ['audit_events', 'proposals', 'asset_lines', 'review_decisions', 'usage_records', 'model_calls'];

const KEY_TABLES = [
  'tenants', 'users', 'role_grants', 'partner_grants', 'sites', 'buildings', 'floors', 'rooms', 'categories',
  'account_classes', 'register_imports', 'register_lines', 'walks', 'clips', 'label_shots', 'jobs', 'stage_runs',
  'frames', 'tracks', 'proposals', 'asset_lines', 'assets', 'review_decisions', 'reconciliations',
  'reconciliation_matches', 'comparisons', 'change_items', 'investigations', 'reports', 'audit_events',
];

describe('migration files', () => {
  it('are numbered, with a down file for each, and refuse duplicate versions', async () => {
    const files = await listMigrations();
    expect(files.map((f) => f.version)).toEqual(files.map((_, i) => String(i + 1).padStart(4, '0')));
    expect(files.every((f) => f.downPath !== null)).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), 'domesday-migrations-'));
    try {
      await writeFile(join(dir, '0001_one.sql'), 'SELECT 1;');
      await writeFile(join(dir, '0001_two.sql'), 'SELECT 2;');
      await expect(listMigrations(dir)).rejects.toThrow(/share version 0001/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(backends)('$label', (backend) => {
  let db: TestDatabase;
  let a: SeededTenant;
  let b: SeededTenant;
  let walkId: string;
  let clipId: string;

  beforeAll(async () => {
    db = await backend.create();
    a = await seedTenant(db, 'tenant-a');
    b = await seedTenant(db, 'tenant-b');
    walkId = await seedWalk(db, a);
    clipId = await seedClip(db, a, walkId);
    await db.rows("INSERT INTO audit_events (tenant_id, actor_kind, action, object_type) VALUES ($1, 'system', 'settings.changed', 'tenant')", [
      a.tenantId,
    ]);
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('the runner', () => {
    it('has applied every numbered migration once, and a second run applies nothing', async () => {
      const applied = await db.rows<{ version: string }>('SELECT version FROM meta.schema_migrations ORDER BY version');
      expect(applied.map((r) => r.version)).toEqual((await listMigrations()).map((f) => f.version));
      expect((await migrate(db.sql)).applied).toEqual([]);
    });

    it('refuses to run when an applied migration file has been edited (expand and contract instead)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'domesday-migrations-'));
      try {
        await cp(MIGRATIONS_DIR, dir, { recursive: true });
        await appendFile(join(dir, '0002_sites.sql'), '\n-- edited after it was applied\n');
        await refused(migrate(db.sql, { dir }), /0002_sites was changed after it was applied/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('ADR-DMS-01: every table carries tenant_id with row-level security', () => {
    it('every table in public has a NOT NULL uuid tenant_id, forced row-level security and a policy', async () => {
      const tables = await db.rows<{ name: string; has_tenant: boolean; rls: boolean; forced: boolean; policies: number }>(`
        SELECT c.relname AS name,
               EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnotnull
                         AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) AS has_tenant,
               c.relrowsecurity AS rls,
               c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`);
      expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(KEY_TABLES));
      for (const t of tables) {
        expect(t, t.name).toMatchObject({ has_tenant: true, rls: true, forced: true });
        expect(t.policies, t.name).toBeGreaterThan(0);
      }
    });

    it('a tenant sees only its own rows', async () => {
      expect(await db.asApp(a.tenantId, (q) => q('SELECT id FROM sites'))).toEqual([{ id: a.siteId }]);
      expect(await db.asApp(b.tenantId, (q) => q('SELECT id FROM sites'))).toEqual([{ id: b.siteId }]);
      expect(await db.asApp(a.tenantId, (q) => q('SELECT id FROM clips'))).toEqual([{ id: clipId }]);
      expect(await db.asApp(b.tenantId, (q) => q('SELECT id FROM clips'))).toEqual([]);
    });

    it('with no tenant set, nothing is visible and nothing can be written: isolation fails closed', async () => {
      await db.asApp(null, async (q) => {
        expect(await q('SELECT * FROM sites')).toEqual([]);
        expect(await q('SELECT * FROM tenants')).toEqual([]);
        expect(await q('SELECT * FROM audit_events')).toEqual([]);
      });
      await refused(
        db.asApp(null, (q) => q("INSERT INTO sites (tenant_id, name) VALUES ($1, 'Somewhere')", [a.tenantId])),
        /row-level security/,
      );
    });

    it('cannot write a row into another tenant', async () => {
      await refused(
        db.asApp(a.tenantId, (q) => q("INSERT INTO sites (tenant_id, name) VALUES ($1, 'Intruder')", [b.tenantId])),
        /row-level security/,
      );
    });

    it("cannot change or delete another tenant's rows", async () => {
      await db.asApp(a.tenantId, async (q) => {
        expect(await q("UPDATE sites SET name = 'Taken' WHERE id = $1 RETURNING id", [b.siteId])).toEqual([]);
        expect(await q('DELETE FROM rooms WHERE id = $1 RETURNING id', [b.roomId])).toEqual([]);
      });
      expect(await db.rows('SELECT name FROM sites WHERE id = $1', [b.siteId])).toEqual([{ name: 'tenant-b site' }]);
    });

    it("cannot point a row at another tenant's row, because every foreign key includes tenant_id", async () => {
      await refused(
        db.asApp(a.tenantId, (q) => q("INSERT INTO buildings (tenant_id, site_id, name) VALUES ($1, $2, 'Block A')", [a.tenantId, b.siteId])),
        /foreign key/,
      );
    });
  });

  describe('DMS-092: audit_events is append-only', () => {
    it('the application role can append events, and the server sets the time', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const [row] = await q<{ at: Date }>(
          `INSERT INTO audit_events (tenant_id, actor_kind, actor_user_id, action, object_type, object_id, at)
           VALUES ($1, 'user', $2, 'clip.verified', 'clip', $3, '2001-01-01T00:00:00Z') RETURNING at`,
          [a.tenantId, a.userId, clipId],
        );
        expect(new Date(row!.at).getUTCFullYear()).toBeGreaterThan(2001);
      });
    });

    it('the application role is refused UPDATE, DELETE and TRUNCATE', async () => {
      await refused(db.asApp(a.tenantId, (q) => q("UPDATE audit_events SET reason = 'rewritten'")), /permission denied/);
      await refused(db.asApp(a.tenantId, (q) => q('DELETE FROM audit_events')), /permission denied/);
      await refused(db.asApp(a.tenantId, (q) => q('TRUNCATE audit_events')), /permission denied/);
    });

    it('even the table owner (here a superuser) cannot update, delete or truncate', async () => {
      await refused(db.asOwner((q) => q("UPDATE audit_events SET reason = 'rewritten'")), /not allowed/);
      await refused(db.asOwner((q) => q('DELETE FROM audit_events')), /not allowed/);
      await refused(db.asOwner((q) => q('TRUNCATE audit_events')), /not allowed/);
      expect(await db.rows('SELECT reason FROM audit_events WHERE tenant_id = $1', [a.tenantId])).toEqual([{ reason: null }]);
    });

    it('no role holds UPDATE, DELETE or TRUNCATE on audit_events, and nobody is in pg_write_all_data', async () => {
      const holders = await db.rows(`
        SELECT r.rolname FROM pg_roles r
        WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\\_%'
          AND (has_table_privilege(r.oid, 'public.audit_events', 'UPDATE')
               OR has_table_privilege(r.oid, 'public.audit_events', 'DELETE')
               OR has_table_privilege(r.oid, 'public.audit_events', 'TRUNCATE'))`);
      expect(holders).toEqual([]);
      const members = await db.rows(`
        SELECT m.member FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'pg_write_all_data'`);
      expect(members).toEqual([]);
    });

    it('every append-only table gives the application role SELECT and INSERT only', async () => {
      for (const table of APPEND_ONLY) {
        const [p] = await db.rows<Record<string, boolean>>(
          `SELECT has_table_privilege('domesday_app', $1, 'SELECT') AS s, has_table_privilege('domesday_app', $1, 'INSERT') AS i,
                  has_table_privilege('domesday_app', $1, 'UPDATE') AS u, has_table_privilege('domesday_app', $1, 'DELETE') AS d`,
          [table],
        );
        expect(p, table).toEqual({ s: true, i: true, u: false, d: false });
      }
    });
  });

  describe('capture records (DMS-010, DMS-017, DMS-018, DMS-090, DMS-094)', () => {
    it('DMS-018: a clip is verified only when the server fingerprint matches the phone fingerprint', async () => {
      const verify = `UPDATE clips SET status = 'verified', sha256 = $2, server_sha256 = $3, storage_key = 'originals/c',
                        retention_until = now() + interval '13 months', server_time = now(), device_time = now(), verified_at = now()
                      WHERE id = $1 RETURNING id`;
      await refused(db.asApp(a.tenantId, (q) => q(verify, [clipId, HASH_A, HASH_B])), /verified_needs_matching_fingerprint/);
      expect(await db.asApp(a.tenantId, (q) => q(verify, [clipId, HASH_A, HASH_A]))).toHaveLength(1);
      await refused(
        db.asApp(a.tenantId, (q) =>
          q("UPDATE clips SET status = 'rejected', sha256 = $2, server_sha256 = $2, rejected_at = now() WHERE id = $1", [clipId, HASH_A]),
        ),
        /rejected_means_mismatch/,
      );
    });

    it('DMS-017: capture metadata cannot be changed', async () => {
      await refused(db.asApp(a.tenantId, (q) => q("UPDATE clips SET device_id = 'another-phone' WHERE id = $1", [clipId])), /DMS-017/);
      await refused(db.asApp(a.tenantId, (q) => q('UPDATE clips SET captured_by = $2 WHERE id = $1', [clipId, b.userId])), /DMS-017/);
    });

    it('DMS-018 and DMS-090: fingerprints never change once set, retention is never shortened, rows are never deleted', async () => {
      await db.asApp(a.tenantId, async (q) => {
        await q('UPDATE clips SET sha256 = $2 WHERE id = $1', [clipId, HASH_A]);
        expect(await attempt(q, 'UPDATE clips SET sha256 = $2 WHERE id = $1', [clipId, HASH_B])).toMatch(/cannot be changed once recorded/);
        await q("UPDATE clips SET retention_until = now() + interval '24 months' WHERE id = $1", [clipId]);
        expect(await attempt(q, "UPDATE clips SET retention_until = now() + interval '13 months' WHERE id = $1", [clipId])).toMatch(
          /extended but never shortened/,
        );
        expect(await attempt(q, 'DELETE FROM clips WHERE id = $1', [clipId])).toMatch(/permission denied/);
      });
    });

    it('DMS-094: the stored clock-gap flag agrees with the domain rule at the boundaries', async () => {
      const serverTime = new Date('2026-11-03T10:00:00Z');
      for (const seconds of [0, 599, 600, 601, -601, 2 * 24 * 3600]) {
        const deviceTime = new Date(serverTime.getTime() - seconds * 1000);
        const [row] = await db.asApp(a.tenantId, (q) =>
          q<{ clock_gap_flag: boolean }>('UPDATE clips SET device_time = $2, server_time = $3 WHERE id = $1 RETURNING clock_gap_flag', [
            clipId,
            deviceTime.toISOString(),
            serverTime.toISOString(),
          ]),
        );
        expect(row?.clock_gap_flag, `${seconds} seconds`).toBe(assessClockGap(deviceTime, serverTime).flagged);
      }
    });

    it('DMS-010: a skipped room needs a reason', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const insert = `INSERT INTO walk_rooms (tenant_id, walk_id, room_id, site_id, status, skip_reason) VALUES ($1, $2, $3, $4, 'skipped', $5)`;
        const args = (reason: string | null) => [a.tenantId, walkId, a.roomId, a.siteId, reason];
        expect(await attempt(q, insert, args(null))).toMatch(/skipped_room_needs_reason/);
        expect(await attempt(q, insert, args('   '))).toMatch(/skipped_room_needs_reason/);
        expect(await attempt(q, insert, args('Locked; key with security'))).toBeNull();
      });
    });

    it('DMS-136: the retention bounds in the database match the domain rule', async () => {
      for (const months of [12, 13, 84, 85]) {
        const update = db.asApp(a.tenantId, (q) =>
          q('UPDATE tenants SET originals_retention_months = $1 WHERE tenant_id = $2 RETURNING tenant_id', [months, a.tenantId]),
        );
        if (checkRetentionMonths(months).ok) expect(await update).toHaveLength(1);
        else await refused(update, /originals_retention_months/);
      }
    });
  });

  describe('review and processing records', () => {
    const insertLine = `INSERT INTO asset_lines (tenant_id, line_id, version, walk_id, site_id, room_id, kind, quantity, category_id,
                          condition, status, approved_by, approved_at, reason, serial, serial_source_region)
                        VALUES ($1, $2, $3, $4, $5, $6, 'counted_group', $7, $8, 'good', $9, $10, $11, $12, $13, $14)`;
    const line = (lineId: string, version: number, opts: { quantity?: number; approved?: boolean; reason?: string | null; serial?: string; region?: object | null } = {}) => [
      a.tenantId, lineId, version, walkId, a.siteId, a.roomId, opts.quantity ?? 32, a.categoryId,
      opts.approved ? 'accepted' : 'proposed', opts.approved ? a.userId : null, opts.approved ? new Date().toISOString() : null,
      opts.reason ?? null, opts.serial ?? null, opts.region === undefined ? null : JSON.stringify(opts.region),
    ];

    it('DMS-093: a change to an approved line needs a reason and writes a new version; earlier versions stay', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const lineId = randomUUID();
        await q(insertLine, line(lineId, 1, { approved: true }));
        expect(await attempt(q, insertLine, line(lineId, 2, { quantity: 31 }))).toMatch(/reason_required/);
        expect(await attempt(q, insertLine, line(lineId, 3, { quantity: 31, reason: 'Recount' }))).toMatch(/next version is 2/);
        expect(await attempt(q, insertLine, line(lineId, 2, { quantity: 31, reason: 'Recount found 31' }))).toBeNull();
        expect(await q('SELECT version, quantity FROM asset_lines WHERE line_id = $1 ORDER BY version', [lineId])).toEqual([
          { version: 1, quantity: 32 },
          { version: 2, quantity: 31 },
        ]);
        expect(await attempt(q, 'UPDATE asset_lines SET quantity = 1 WHERE line_id = $1', [lineId])).toMatch(/permission denied/);
      });
    });

    it('Part 5: a serial with no source region is rejected, on lines and on proposals', async () => {
      await db.asApp(a.tenantId, async (q) => {
        // Both a missing region (SQL NULL) and a JSON null are refused.
        expect(await attempt(q, insertLine, line(randomUUID(), 1, { serial: 'SN-1' }))).toMatch(/serial_needs_source_region/);
        expect(await attempt(q, insertLine, line(randomUUID(), 1, { serial: 'SN-1', region: null }))).toMatch(/serial_needs_source_region/);
        expect(
          await attempt(q, insertLine, line(randomUUID(), 1, { serial: 'SN-1', region: { frameId: 'f', x: 0, y: 0, width: 0.1, height: 0.1 } })),
        ).toBeNull();
        const proposal = `INSERT INTO proposals (tenant_id, walk_id, proposal_key, fields, evidence, confidence_band, model_version, prompt_version)
                          VALUES ($1, $2, $3, $4, $5, 'high', 'm1', 'p1')`;
        expect(await attempt(q, proposal, [a.tenantId, walkId, 'k1', '{"serial": "SN-9"}', '{"frames": []}'])).toMatch(
          /serial_needs_source_region/,
        );
        expect(await attempt(q, proposal, [a.tenantId, walkId, 'k3', '{"serial": "SN-9"}', '{"regions": {"serial": null}}'])).toMatch(
          /serial_needs_source_region/,
        );
        expect(
          await attempt(q, proposal, [a.tenantId, walkId, 'k2', '{"serial": "SN-9"}', '{"regions": {"serial": {"frameId": "f"}}}']),
        ).toBeNull();
        expect(await attempt(q, "UPDATE proposals SET confidence_band = 'low'")).toMatch(/permission denied/);
      });
    });

    it('DMS-042: a job is keyed by clip, stage and model version, so a repeat is harmless', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const once = `INSERT INTO jobs (tenant_id, walk_id, clip_id, stage, model_version) VALUES ($1, $2, $3, $4, $5)
                      ON CONFLICT ON CONSTRAINT job_key DO NOTHING RETURNING id`;
        expect(await q(once, [a.tenantId, walkId, clipId, 'privacy_pass', 'blur-1'])).toHaveLength(1);
        expect(await q(once, [a.tenantId, walkId, clipId, 'privacy_pass', 'blur-1'])).toHaveLength(0);
        expect(await q(once, [a.tenantId, walkId, clipId, 'privacy_pass', 'blur-2'])).toHaveLength(1);
        expect(await q(once, [a.tenantId, walkId, null, 'assemble_and_score', 'asm-1'])).toHaveLength(1);
        expect(await q(once, [a.tenantId, walkId, null, 'assemble_and_score', 'asm-1'])).toHaveLength(0);
        expect(
          await attempt(q, 'INSERT INTO jobs (tenant_id, walk_id, clip_id, stage, model_version) VALUES ($1, $2, $3, $4, $5)', [
            a.tenantId, walkId, clipId, 'privacy_pass', 'blur-1',
          ]),
        ).toMatch(/job_key/);
      });
    });
  });

  describe('other requirements held by the schema', () => {
    it('DMS-004: an imported line keeps every source field unchanged', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const [imp] = await q<{ id: string }>(
          "INSERT INTO register_imports (tenant_id, file_name, file_kind, storage_key, created_by) VALUES ($1, 'fa.xlsx', 'xlsx', 'imports/fa.xlsx', $2) RETURNING id",
          [a.tenantId, a.userId],
        );
        const [row] = await q<{ id: string }>(
          `INSERT INTO register_lines (tenant_id, register_import_id, row_number, source_fields, description)
           VALUES ($1, $2, 1, '{"Asset No": "FA-0042", "Desc": "Generator 60KVA", "NBV": "1,250,000.00"}', 'Generator 60KVA') RETURNING id`,
          [a.tenantId, imp!.id],
        );
        expect(await attempt(q, `UPDATE register_lines SET source_fields = '{"Asset No": "FA-0043"}' WHERE id = $1`, [row!.id])).toMatch(/DMS-004/);
        expect(await attempt(q, 'UPDATE register_lines SET category_id = $2 WHERE id = $1', [row!.id, a.categoryId])).toBeNull();
      });
    });

    it('DMS-096: a legal hold is lifted only with two different administrators', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const [second] = await q<{ id: string }>(
          "INSERT INTO users (tenant_id, auth_subject, display_name, email) VALUES ($1, 'auth|second', 'Second admin', 'second@example.com') RETURNING id",
          [a.tenantId],
        );
        const [hold] = await q<{ id: string }>(
          "INSERT INTO legal_holds (tenant_id, site_id, reason, placed_by) VALUES ($1, $2, 'Claim pending', $3) RETURNING id",
          [a.tenantId, a.siteId, a.userId],
        );
        const lift = 'UPDATE legal_holds SET lifted_at = now(), lift_approved_by_1 = $2, lift_approved_by_2 = $3 WHERE id = $1';
        expect(await attempt(q, lift, [hold!.id, a.userId, null])).toMatch(/lifted_by_two_administrators/);
        expect(await attempt(q, lift, [hold!.id, a.userId, a.userId])).toMatch(/lifted_by_two_administrators/);
        expect(await attempt(q, lift, [hold!.id, a.userId, second!.id])).toBeNull();
      });
    });

    it('Part 5: the AI gateway only accepts routes to providers with zero data retention', async () => {
      await db.asApp(a.tenantId, async (q) => {
        const route = `INSERT INTO model_routes (tenant_id, stage, provider, model, model_version, prompt_version, zero_data_retention)
                       VALUES ($1, 'describe_and_grade', 'provider-x', 'model-x', '1', '1', $2)`;
        expect(await attempt(q, route, [a.tenantId, false])).toMatch(/zero_data_retention_only/);
        expect(await attempt(q, route, [a.tenantId, true])).toBeNull();
      });
    });

    it('DMS-120 and DMS-121: a partner sees exactly the client tenants with a live grant, and none of their data', async () => {
      const partner = await seedTenant(db, 'partner-p', 'partner');
      const c = await seedTenant(db, 'tenant-c');
      const d = await seedTenant(db, 'tenant-d');
      for (const client of [a, b, d]) {
        await db.rows('INSERT INTO partner_grants (tenant_id, partner_tenant_id, all_sites, granted_by) VALUES ($1, $2, true, $3)', [
          client.tenantId, partner.tenantId, client.userId,
        ]);
      }
      await db.rows('UPDATE partner_grants SET revoked_at = now(), revoked_by = $2 WHERE tenant_id = $1', [d.tenantId, d.userId]);

      const visible = await db.asApp(partner.tenantId, (q) => q<{ name: string }>('SELECT name FROM tenants ORDER BY name'));
      expect(visible.map((t) => t.name)).toEqual(['partner-p', 'tenant-a', 'tenant-b']);
      expect(visible.map((t) => t.name)).not.toContain(c.tenantId);
      expect(await db.asApp(partner.tenantId, (q) => q('SELECT id FROM sites'))).toEqual([{ id: partner.siteId }]);
    });

    it('DMS-086: with no tenant set, a verification code makes only its own report visible, and issued reports cannot change', async () => {
      await db.rows(
        `INSERT INTO reports (tenant_id, type, scope, status, sha256, verification_code, storage_key, generated_by, generated_at)
         VALUES ($1, 'audit_verification', '{}', 'issued', $2, 'AB12-CD34-EF56', 'reports/a.pdf', $3, now()),
                ($4, 'audit_verification', '{}', 'issued', $5, 'GH78-JK90-MN12', 'reports/b.pdf', $6, now())`,
        [a.tenantId, HASH_A, a.userId, b.tenantId, HASH_B, b.userId],
      );
      const byCode = (code: string) => db.asApp(null, (q) => q<{ sha256: string }>('SELECT sha256 FROM reports'), { 'app.verification_code': code });
      expect(await byCode('AB12-CD34-EF56')).toEqual([{ sha256: HASH_A }]);
      expect(await byCode('ZZZZ-ZZZZ-ZZZZ')).toEqual([]);
      expect(await db.asApp(null, (q) => q('SELECT id FROM reports'))).toEqual([]);
      await refused(db.asApp(a.tenantId, (q) => q('UPDATE reports SET sha256 = $1', [HASH_B])), /has been issued/);
    });
  });

  describe('the database speaks the shared vocabulary', () => {
    const vocabularies: [table: string, column: string, values: readonly string[]][] = [
      ['change_items', 'status', ChangeStatus.values],
      ['change_items', 'matched_by', ComparisonMatchMethod.values],
      ['reconciliation_matches', 'status', ReconStatus.values],
      ['reconciliation_matches', 'method', ReconMatchMethod.values],
      ['asset_lines', 'condition', ConditionGrade.values],
      ['asset_lines', 'confidence_band', ConfidenceBand.values],
      ['proposals', 'confidence_band', ConfidenceBand.values],
      ['asset_lines', 'kind', LineKind.values],
      ['asset_lines', 'status', LineStatus.values],
      ['walk_rooms', 'status', RoomWalkStatus.values],
      ['role_grants', 'role', Role.values],
      ['investigations', 'outcome', InvestigationOutcome.values],
      ['investigations', 'status', InvestigationStatus.values],
      ['walks', 'status', WalkStatus.values],
      ['clips', 'status', ClipUploadStatus.values],
      ['reports', 'type', ReportType.values],
      ['review_decisions', 'decision', ReviewDecisionKind.values],
      ['jobs', 'status', JobStatus.values],
      ['jobs', 'stage', PipelineStage.values.filter((s) => s !== 'human_review')],
    ];

    it.each(vocabularies)('%s.%s allows exactly the domain values', async (table, column, values) => {
      const defs = await db.rows<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.conrelid = $1::regclass AND c.contype = 'c' AND cardinality(c.conkey) = 1 AND a.attname = $2`,
        [table, column],
      );
      const allowed = defs.flatMap((d) => [...d.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));
      expect(new Set(allowed)).toEqual(new Set(values));
    });
  });
});

describe.each(backends)('$label: every migration is reversible', (backend) => {
  it('rolls back all migrations to an empty schema and applies them again', async () => {
    const db = await backend.create();
    try {
      const count = (await listMigrations()).length;
      expect((await rollback(db.sql, { steps: count })).reverted).toHaveLength(count);
      expect(await db.rows("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'")).toEqual([]);
      expect((await migrate(db.sql)).applied).toHaveLength(count);
    } finally {
      await db.close();
    }
  });
});
