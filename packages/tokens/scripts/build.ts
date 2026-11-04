// Reads tokens.json and writes src/generated/tokens.css and src/generated/tokens.ts.
// `--check` writes nothing and fails if the generated files are out of date.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTokens } from '../src/build';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'generated');
const check = process.argv.includes('--check');

const output = buildTokens(JSON.parse(await readFile(join(root, 'tokens.json'), 'utf8')));
const files = { 'tokens.css': output.css, 'tokens.ts': output.ts };

if (check) {
  const stale: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const current = await readFile(join(outDir, name), 'utf8').catch(() => '');
    if (current !== content) stale.push(name);
  }
  if (stale.length > 0) {
    console.error(`Out of date: ${stale.join(', ')}. Run "pnpm tokens" and commit the result.`);
    process.exit(1);
  }
  console.log('Generated token files are up to date.');
} else {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(outDir, name), content);
  console.log(`Wrote ${Object.keys(files).join(' and ')} to ${outDir}`);
}
