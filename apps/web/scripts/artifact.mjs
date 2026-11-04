// Turns the Vite build into a claude.ai artifact: one page fragment (the platform adds the
// document skeleton) with the app's script and styles inline, plus the published files it
// fetches at run time (seed.json, sample footage and the demo walk's frames).
//
//   pnpm --filter @domesday/web build:artifact   ->   apps/web/dist-artifact/
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const out = join(root, 'dist-artifact');

const assets = join(dist, 'assets');
const js = readFileSync(join(assets, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readdirSync(assets)
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(assets, f), 'utf8'))
  .join('\n')
  .replace(/<\/style/gi, '<\\/style');

const fonts =
  'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;500&family=Atkinson+Hyperlegible+Next:wght@400;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap';

const page = `<title>Domesday App</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Film rooms on a phone, approve the asset lines Claude proposes, compare with the last walk and reconcile with the books.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>${css}</style>
<div id="root" class="dms"></div>
<script type="module">${js}</script>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), page);
for (const item of ['seed.json', 'media']) {
  const src = join(dist, item);
  if (existsSync(src)) cpSync(src, join(out, item), { recursive: true });
}

const files = [];
const walk = (dir, rel = '') => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) walk(p, r);
    else if (r !== 'index.html') files.push(r);
  }
};
walk(out);
writeFileSync(join(out, 'files.json'), `${JSON.stringify(files, null, 1)}\n`);
console.log(`index.html ${Math.round(page.length / 1024)} KB, ${files.length} published files`);
