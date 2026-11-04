import { defineConfig } from 'vitest/config';

// TypeScript unit and API tests. The migration tests live in db/ and run with
// `pnpm test:db` so that CI can report them as their own step.
export default defineConfig({
  test: {
    projects: ['packages/domain', 'packages/capture-core', 'packages/tokens', 'apps/api', 'apps/web'],
  },
});
