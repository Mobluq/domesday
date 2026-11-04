import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuditAction,
  ChangeStatus,
  ClipUploadStatus,
  ComparisonMatchMethod,
  ConditionGrade,
  ConfidenceBand,
  CorrectionKind,
  InvestigationOutcome,
  InvestigationStatus,
  JobStatus,
  LineKind,
  LineStatus,
  PERMISSIONS,
  PipelineStage,
  ReconMatchMethod,
  ReconStatus,
  ReportType,
  ReviewDecisionKind,
  Role,
  RoomWalkStatus,
  WalkStatus,
  isPermission,
} from '@domesday/domain';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { MODULE_NAMES } from '../src/app';
import { ERROR_TITLES } from '../src/platform/errors';
import { SPEC_PATH, loadSpec, type JsonSchema } from '../src/platform/openapi';

const spec = loadSpec();
const defs = (spec.schemaDocument.$defs ?? {}) as Record<string, JsonSchema>;
const srcModules = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'modules');

/** Follows references into the shared schema document. */
function deref(schema: JsonSchema | undefined): JsonSchema | undefined {
  let current = schema;
  for (let i = 0; current && typeof current.$ref === 'string' && i < 10; i += 1) {
    current = defs[current.$ref.split('/').at(-1) as string];
  }
  return current;
}

const enumOf = (name: string): unknown[] => (deref({ $ref: `#/$defs/${name}` })?.enum as unknown[]) ?? [];

describe('openapi/domesday.yaml', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(SPEC_PATH);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(String(spec.document.openapi)).toBe('3.1.0');
  });

  it('every operation has an operationId and exactly one tag: a Part 6 module, or platform for the health check', () => {
    const ids = spec.operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of spec.operations) {
      expect([...MODULE_NAMES, 'platform'], op.operationId).toContain(op.module);
    }
    expect(spec.operations.filter((o) => o.module === 'platform').map((o) => o.operationId)).toEqual(['getHealth']);
  });

  it('src/modules has exactly the Part 6 modules, each with a public index.ts', () => {
    const folders = readdirSync(srcModules, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(folders.sort()).toEqual([...MODULE_NAMES].sort());
    for (const m of MODULE_NAMES) expect(existsSync(join(srcModules, m, 'index.ts')), m).toBe(true);
  });

  it('every operation is public or names a permission that exists; only health and report verification are public', () => {
    for (const op of spec.operations) {
      if (op.isPublic) continue;
      expect(isPermission(op.permission), op.operationId).toBe(true);
    }
    expect(spec.operations.filter((o) => o.isPublic).map((o) => o.operationId).sort()).toEqual(['getHealth', 'verifyReport']);
  });

  it('every write takes a required Idempotency-Key header', () => {
    for (const op of spec.operations.filter((o) => o.isWrite)) {
      const headers = op.schemas.headers;
      expect(headers?.required, op.operationId).toContain('idempotency-key');
    }
  });

  it('every list is paginated by cursor: items with nextCursor, and cursor and limit parameters (DMS-157)', () => {
    let lists = 0;
    for (const op of spec.operations) {
      for (const [status, schema] of Object.entries(op.responses)) {
        const resolved = deref(schema);
        expect(resolved?.type, `${op.operationId} ${status} must not be a bare array`).not.toBe('array');
        const properties = resolved?.properties as Record<string, JsonSchema> | undefined;
        if (deref(properties?.items)?.type !== 'array') continue;
        lists += 1;
        expect(resolved?.required, op.operationId).toEqual(expect.arrayContaining(['items', 'nextCursor']));
        const query = op.schemas.querystring?.properties as Record<string, unknown> | undefined;
        expect(Object.keys(query ?? {}), op.operationId).toEqual(expect.arrayContaining(['cursor', 'limit']));
      }
    }
    expect(lists).toBeGreaterThanOrEqual(20);
  });

  it('every operation answers errors in the one problem format', () => {
    for (const op of spec.operations) {
      expect(deref(op.responses.default)?.required, op.operationId).toEqual(expect.arrayContaining(['type', 'status', 'code', 'detail']));
    }
    expect(new Set(enumOf('ErrorCode'))).toEqual(new Set(Object.keys(ERROR_TITLES)));
  });

  it('speaks the shared vocabulary from packages/domain', () => {
    const pairs: [string, readonly string[]][] = [
      ['ChangeStatus', ChangeStatus.values],
      ['ReconStatus', ReconStatus.values],
      ['ConditionGrade', ConditionGrade.values],
      ['ConfidenceBand', ConfidenceBand.values],
      ['RoomWalkStatus', RoomWalkStatus.values],
      ['Role', Role.values],
      ['InvestigationOutcome', InvestigationOutcome.values],
      ['InvestigationStatus', InvestigationStatus.values],
      ['ReviewDecisionKind', ReviewDecisionKind.values],
      ['LineKind', LineKind.values],
      ['LineStatus', LineStatus.values],
      ['PipelineStage', PipelineStage.values],
      ['JobStatus', JobStatus.values],
      ['WalkStatus', WalkStatus.values],
      ['ClipUploadStatus', ClipUploadStatus.values],
      ['ReportType', ReportType.values],
      ['CorrectionKind', CorrectionKind.values],
      ['ReconMatchMethod', ReconMatchMethod.values],
      ['ComparisonMatchMethod', ComparisonMatchMethod.values],
      ['AuditAction', AuditAction.values],
      ['Permission', PERMISSIONS],
    ];
    for (const [name, values] of pairs) expect(enumOf(name), name).toEqual([...values]);
  });

  it('every object check names a declared parameter or a property of the request body', () => {
    for (const op of spec.operations) {
      for (const ref of op.objects) {
        if (ref.in === 'body') {
          const [first, second] = ref.name.split('.');
          const body = deref(op.schemas.body);
          const property = deref((body?.properties as Record<string, JsonSchema> | undefined)?.[first as string]);
          expect(property, `${op.operationId}: body.${ref.name}`).toBeDefined();
          if (second) {
            const nested = [property, ...((property?.oneOf as JsonSchema[] | undefined) ?? [])].some(
              (s) => (s?.properties as Record<string, unknown> | undefined)?.[second] !== undefined,
            );
            expect(nested, `${op.operationId}: body.${ref.name}`).toBe(true);
          }
        } else {
          const group = ref.in === 'path' ? op.schemas.params : op.schemas.querystring;
          expect(Object.keys((group?.properties as object) ?? {}), `${op.operationId}: ${ref.in}.${ref.name}`).toContain(ref.name);
        }
      }
    }
  });

  it('every path parameter of an object a route acts on is checked by the authorisation layer', () => {
    const exempt = new Set(['createClipUploadSession:clipId', 'verifyReport:verificationCode']);
    for (const op of spec.operations) {
      for (const name of Object.keys((op.schemas.params?.properties as object) ?? {})) {
        if (exempt.has(`${op.operationId}:${name}`)) continue;
        expect(
          op.objects.some((o) => o.in === 'path' && o.name === name),
          `${op.operationId} must check path parameter ${name}`,
        ).toBe(true);
      }
    }
  });
});
