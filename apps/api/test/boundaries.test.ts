import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callWithGatewayPolicy, chooseRoute, NoApprovedRouteError, type ModelRoute } from '../src/modules/ai-gateway/index';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const config = join(repoRoot, '.dependency-cruiser.cjs');
const depcruise = join(repoRoot, 'node_modules', '.bin', 'depcruise');

function cruise(fixture: string) {
  const result = spawnSync(depcruise, ['apps/api/src', '--config', config, '--output-type', 'err'], {
    cwd: join(here, 'fixtures', 'boundaries', fixture),
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('dependency-cruiser enforces module boundaries (Part 6)', () => {
  it('fails when one module imports another module\'s internals, or the platform imports a module', () => {
    const { status, output } = cruise('violating');
    expect(status).not.toBe(0);
    expect(output).toContain('no-module-internals');
    expect(output).toContain('modules/alpha/index.ts');
    expect(output).toContain('platform-does-not-import-modules');
  });

  it('passes when modules use each other only through their public index.ts', () => {
    const { status, output } = cruise('allowed');
    expect(output).not.toContain('error');
    expect(status).toBe(0);
  });
});

describe('ai-gateway rules (Part 5 and Part 6)', () => {
  const route = (overrides: Partial<ModelRoute>): ModelRoute => ({
    id: 'r1',
    stage: 'describe_and_grade',
    provider: 'provider-x',
    model: 'model-x',
    modelVersion: '1',
    promptVersion: '1',
    zeroDataRetention: true,
    enabled: true,
    timeoutMs: 1_000,
    ...overrides,
  });

  it('only routes to enabled providers with zero data retention terms', () => {
    expect(chooseRoute([route({ id: 'keeps-data', zeroDataRetention: false }), route({ id: 'ok' })], 'describe_and_grade').id).toBe('ok');
    expect(() => chooseRoute([route({ zeroDataRetention: false })], 'describe_and_grade')).toThrow(NoApprovedRouteError);
    expect(() => chooseRoute([route({ enabled: false })], 'describe_and_grade')).toThrow(NoApprovedRouteError);
  });

  it('times out a slow call and retries exactly once after a jittered pause', async () => {
    let calls = 0;
    const pauses: number[] = [];
    const result = await callWithGatewayPolicy(
      async () => {
        calls += 1;
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 200));
        return 'described';
      },
      { timeoutMs: 20, random: () => 0.5, sleep: async (ms) => void pauses.push(ms) },
    );
    expect(result).toBe('described');
    expect(calls).toBe(2);
    expect(pauses).toEqual([500]);

    let failures = 0;
    await expect(
      callWithGatewayPolicy(
        async () => {
          failures += 1;
          throw new Error('provider down');
        },
        { timeoutMs: 50, random: () => 0, sleep: async () => undefined },
      ),
    ).rejects.toThrow('provider down');
    expect(failures).toBe(2);
  });
});
