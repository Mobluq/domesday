// Entry point: `pnpm --filter @domesday/api dev`. Configuration comes from the environment (twelve-factor).
import { buildApp } from './app';
import { StaticTokenAuthenticator, parseDevTokens } from './modules/tenancy-access/index';
import { createPgDatabase } from './platform/db';
import { InMemoryObjectStore } from './platform/object-store';

const env = process.env;
const production = env.NODE_ENV === 'production';

// Fail closed: the bought sign-in provider (ADR-DMS-05) and the write-once object
// store are not wired in yet, so nothing here may run in production.
if (production) {
  console.error('Refusing to start in production: no sign-in provider or object-lock storage is configured yet (ADR-DMS-05).');
  process.exit(1);
}
if (!env.DATABASE_URL) {
  console.error('Set DATABASE_URL, for example postgres://postgres@localhost:5432/domesday');
  process.exit(1);
}
if (!env.DOMESDAY_DEV_TOKENS) {
  console.error('Set DOMESDAY_DEV_TOKENS to a JSON object of development tokens (see README).');
  process.exit(1);
}

const db = createPgDatabase({ connectionString: env.DATABASE_URL });
const app = await buildApp({
  db,
  objectStore: new InMemoryObjectStore(),
  authenticator: new StaticTokenAuthenticator(parseDevTokens(env.DOMESDAY_DEV_TOKENS)),
  logger: true,
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3000) });
