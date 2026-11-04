import { HttpError, env } from './http.js';

/**
 * The document store. Two ways in, whichever the Vercel project has:
 *
 * - Upstash Redis over its REST API: one POST to `${url}/pipeline` per batch of commands,
 *   with the REST token as a Bearer token. Works with the names the Vercel Marketplace
 *   integration sets (KV_REST_API_URL and KV_REST_API_TOKEN) and Upstash's own
 *   (UPSTASH_REDIS_REST_URL and _TOKEN).
 * - Any Redis over TCP, from a redis:// or rediss:// connection string in REDIS_URL (what the
 *   Marketplace's Redis stores set). One client per function instance, reused while warm.
 */

export type RedisCommand = readonly (string | number)[];

export interface Redis {
  /** Runs the commands in order and returns each command's result. Throws if any command failed. */
  pipeline(commands: readonly RedisCommand[]): Promise<unknown[]>;
}

export interface RedisConfig {
  readonly url: string;
  readonly token: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENV_PAIRS = [
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
] as const;

export function redisConfig(): RedisConfig | null {
  for (const [urlName, tokenName] of ENV_PAIRS) {
    const url = env(urlName);
    const token = env(tokenName);
    if (url && token && /^https?:\/\/[^\s/]/i.test(url)) return { url: url.replace(/\/+$/, ''), token };
  }
  return null;
}

const UNAVAILABLE = "The document store couldn't be reached. Try again in a moment.";

export function createRedis(config: RedisConfig, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Redis {
  return {
    async pipeline(commands) {
      if (commands.length === 0) return [];
      let res: Response;
      try {
        res = await fetchImpl(`${config.url}/pipeline`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(commands),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new HttpError(502, 'upstream_error', UNAVAILABLE);
      }
      if (!res.ok) {
        console.error('domesday api: store answered', res.status);
        throw new HttpError(502, 'upstream_error', res.status === 401 ? 'The document store refused its token. Check the Upstash settings.' : UNAVAILABLE);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new HttpError(502, 'upstream_error', UNAVAILABLE);
      }
      if (!Array.isArray(body) || body.length !== commands.length) throw new HttpError(502, 'upstream_error', UNAVAILABLE);
      return body.map((item: unknown) => {
        const r = (item ?? {}) as { result?: unknown; error?: unknown };
        if (r.error !== undefined) {
          console.error('domesday api: a store command failed');
          throw new HttpError(502, 'upstream_error', 'The document store could not run that request.');
        }
        return r.result ?? null;
      });
    },
  };
}

/** A redis:// or rediss:// connection string, when the project has one. */
export function redisUrl(): string | null {
  for (const name of ['REDIS_URL', 'KV_URL']) {
    const v = env(name);
    if (v && /^rediss?:\/\/[^\s]+$/i.test(v)) return v;
  }
  return null;
}

/** True when either kind of store is configured. */
export function storeConfigured(): boolean {
  return redisConfig() !== null || redisUrl() !== null;
}

interface TcpClient {
  pipeline(): { call(command: string, ...args: string[]): unknown; exec(): Promise<[Error | null, unknown][] | null> };
  on(event: 'error', listener: (e: Error) => void): unknown;
}

let tcpClient: Promise<TcpClient> | null = null;

async function tcpConnect(url: string): Promise<TcpClient> {
  const { Redis: IORedis } = await import('ioredis');
  const client = new IORedis(url, {
    connectTimeout: 8_000,
    maxRetriesPerRequest: 2,
    enableReadyCheck: false,
    ...(url.toLowerCase().startsWith('rediss://') ? { tls: {} } : {}),
  }) as unknown as TcpClient;
  // Errors surface on the command that hits them; the listener stops an unhandled event.
  client.on('error', (e) => console.error('domesday api: store connection', e.name));
  return client;
}

/** Redis over TCP with the same pipeline contract as the REST client. */
export function createTcpRedis(url: string): Redis {
  return {
    async pipeline(commands) {
      if (commands.length === 0) return [];
      tcpClient ??= tcpConnect(url).catch((e: unknown) => {
        tcpClient = null;
        throw e;
      });
      let results: [Error | null, unknown][] | null;
      try {
        const client = await tcpClient;
        const p = client.pipeline();
        for (const [command, ...args] of commands) p.call(String(command), ...args.map(String));
        results = await p.exec();
      } catch {
        tcpClient = null;
        throw new HttpError(502, 'upstream_error', UNAVAILABLE);
      }
      if (!results || results.length !== commands.length) throw new HttpError(502, 'upstream_error', UNAVAILABLE);
      return results.map(([err, value]) => {
        if (err) {
          console.error('domesday api: a store command failed');
          throw new HttpError(502, 'upstream_error', 'The document store could not run that request.');
        }
        return value ?? null;
      });
    },
  };
}

/** The configured store, or a 503 telling the owner to add one. */
export function redisFromEnv(): Redis {
  const config = redisConfig();
  if (config) return createRedis(config);
  const url = redisUrl();
  if (url) return createTcpRedis(url);
  throw new HttpError(503, 'not_configured', 'No document store is set up. Add a Redis store (Upstash or Redis) to this Vercel project.');
}
