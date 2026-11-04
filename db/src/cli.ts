// Usage: DATABASE_URL=postgres://... pnpm --filter @domesday/db migrate [up|down|status]
import pg from 'pg';
import { fromPg, migrate, migrationStatus, rollback } from './migrate';

const command = process.argv[2] ?? 'up';
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to the database to migrate.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const sql = fromPg(client);
  const log = (line: string): void => console.log(line);
  if (command === 'up') {
    const { applied } = await migrate(sql, { log });
    if (applied.length === 0) console.log('Nothing to apply.');
  } else if (command === 'down') {
    await rollback(sql, { log, steps: Number(process.argv[3] ?? 1) });
  } else if (command === 'status') {
    for (const m of await migrationStatus(sql)) console.log(`${m.applied ? 'applied' : 'pending'}  ${m.version}_${m.name}`);
  } else {
    console.error(`Unknown command "${command}". Use up, down or status.`);
    process.exitCode = 2;
  }
} finally {
  await client.end();
}
