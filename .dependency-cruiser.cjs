/**
 * Module boundaries, checked in CI (PRD Part 6: "Boundaries are enforced in CI with
 * a dependency checker (dependency-cruiser for TypeScript)").
 *
 * Run from the repo root: pnpm depcruise
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-module-internals',
      comment:
        'A module may use another module only through its public index.ts. Each module owns its tables; others call its public interface (Part 6).',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'platform-does-not-import-modules',
      comment: 'The shared platform layer (HTTP, authorisation, database) must not depend on any business module.',
      severity: 'error',
      from: { path: '^apps/api/src/platform/' },
      to: { path: '^apps/api/src/modules/' },
    },
    {
      name: 'no-circular',
      comment: 'Circular imports hide coupling between modules.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-packages-stay-portable',
      comment: 'domain and capture-core also run on phones and in browsers, so no Node built-ins.',
      severity: 'error',
      from: { path: '^packages/(domain|capture-core)/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'domain-depends-on-nothing-internal',
      comment: 'The shared vocabulary is the bottom layer: it imports no other workspace code.',
      severity: 'error',
      from: { path: '^packages/domain/src/' },
      to: { path: '^(apps|db|workers|packages/(?!domain/))' },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist)/' },
    // Type-only imports count too: a module must not reach another's internal types.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
