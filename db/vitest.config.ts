import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // One PGlite instance and one real database per file; files run one at a time to keep memory low.
    fileParallelism: false,
  },
});
