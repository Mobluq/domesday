/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // The API runs on port 3000 in development (apps/api).
    proxy: { '/v1': 'http://127.0.0.1:3000' },
  },
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
  },
});
