// Public interface of the AI gateway module. Owns: model_routes, model_calls,
// stage_switches. Every hosted-model call goes through here (Part 6). It has no
// public HTTP operations.
import type { ModuleDefinition } from '../../platform/operation';

export interface ModelRoute {
  readonly id: string;
  readonly stage: 'describe_and_grade';
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly zeroDataRetention: boolean;
  readonly enabled: boolean;
  readonly timeoutMs: number;
}

export class NoApprovedRouteError extends Error {
  override readonly name = 'NoApprovedRouteError';
}

/**
 * Part 5: footage only ever goes to providers with zero data retention terms, and
 * a stage switched off for the tenant has no route (the kill switch). The database
 * refuses a route without zero retention too; this is the second check.
 */
export function chooseRoute(routes: readonly ModelRoute[], stage: ModelRoute['stage']): ModelRoute {
  const route = routes.find((r) => r.stage === stage && r.enabled && r.zeroDataRetention);
  if (!route) throw new NoApprovedRouteError(`no approved, enabled route for ${stage}`);
  return route;
}

export class GatewayTimeoutError extends Error {
  override readonly name = 'GatewayTimeoutError';
}

/**
 * Part 6: every hosted-model call has a timeout and is retried once, after a
 * jittered pause. This is the only retry layer for these calls (playbook practice 3).
 */
export async function callWithGatewayPolicy<T>(
  call: (signal: AbortSignal) => Promise<T>,
  options: { readonly timeoutMs: number; readonly random?: () => number; readonly sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempt = async (): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GatewayTimeoutError(`model call timed out after ${options.timeoutMs} ms`));
      }, options.timeoutMs);
    });
    try {
      return await Promise.race([call(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await attempt();
  } catch {
    await sleep(Math.floor(random() * 1_000));
    return attempt();
  }
}

export function createAiGatewayModule(): { definition: ModuleDefinition } {
  return { definition: { name: 'ai-gateway' } };
}
