// Reads design-system/tokens.json (exported from the Domesday Design System) and writes
// tokens.json and src/generated/typography.css. Run "pnpm tokens:sync" from the repo root,
// which also rebuilds tokens.css and tokens.ts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDesignSystem, typographyCss, type DesignSystemTokens } from '../src/sync';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ds = JSON.parse(await readFile(join(root, 'design-system', 'tokens.json'), 'utf8')) as DesignSystemTokens;

await writeFile(join(root, 'tokens.json'), `${JSON.stringify(fromDesignSystem(ds), null, 2)}\n`);
await mkdir(join(root, 'src', 'generated'), { recursive: true });
await writeFile(join(root, 'src', 'generated', 'typography.css'), typographyCss(ds));
console.log('Wrote tokens.json and src/generated/typography.css from design-system/tokens.json');
