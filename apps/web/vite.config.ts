/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The build is published as a claude.ai artifact (see scripts/artifact.mjs), so paths are
// relative, there is one script and one stylesheet, and small images are inlined. The sign-in
// screen's room model is a separate chunk on the website; an artifact page loads one script, so
// the artifact build leaves the model out (it never shows the access code screen anyway).
const artifact = process.env.DOMESDAY_ARTIFACT === '1';

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __ARTIFACT__: JSON.stringify(artifact) },
  build: {
    target: 'es2022',
    assetsInlineLimit: 12_000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    // The API runs on port 3000 in development (apps/api).
    proxy: { '/v1': 'http://127.0.0.1:3000' },
  },
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
  },
});
