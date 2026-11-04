import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'capture-core',
    include: ['test/**/*.test.ts'],
  },
});
