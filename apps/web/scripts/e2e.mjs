/* global window, document */
// End-to-end run of the demo against the artifact build, with a stand-in for the claude.ai
// runtime: no shared store (the in-browser store is used), and a fake `sample` that answers
// with fixed proposals per room. Exercises capture with the sample footage, review, approval,
// comparison, reconciliation, issuing a report and verifying it.
//
//   pnpm --filter @domesday/web build:artifact && node apps/web/scripts/e2e.mjs [screenshot-dir]
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-artifact');
const shots = process.argv[2] ?? null;
if (shots) mkdirSync(shots, { recursive: true });

const SKELETON = (body) =>
  `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;
const TYPES = { '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.html': 'text/html' };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SKELETON(readFileSync(join(root, 'index.html'), 'utf8')));
    return;
  }
  const p = join(root, decodeURIComponent(url.pathname));
  if (!p.startsWith(root) || !existsSync(p)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

// Fixed answers per room, in the shape the prompt asks for.
const FAKE = `
window.__answers = {
  'Room 204': { lines: [
    { category: 'bed', description: 'King-size bed with upholstered headboard', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'No visible wear', confidence: 'high', confidence_reason: 'Clearly visible', safety: null, seen_in: [{ image: 'F1', box: [0.55, 0.45, 0.45, 0.4] }, { image: 'F6', box: [0, 0.25, 1, 0.75] }], reads: [] },
    { category: 'armchair', description: 'Upholstered armchair, cream fabric, dark wood frame', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'No visible wear', confidence: 'high', confidence_reason: 'Seen from two angles', safety: null, seen_in: [{ image: 'F2', box: [0.17, 0.27, 0.66, 0.62] }], reads: [] },
    { category: 'floor-lamp', description: 'Floor lamp with tripod legs and linen shade', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'No visible wear', confidence: 'high', confidence_reason: 'Clearly visible', safety: null, seen_in: [{ image: 'F3', box: [0.3, 0.05, 0.4, 0.9] }], reads: [] },
    { category: 'framed-art', description: 'Framed print of a white lily', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'No visible wear', confidence: 'medium', confidence_reason: 'Partly cut off at the top', safety: null, seen_in: [{ image: 'F4', box: [0.32, 0, 0.42, 0.86] }], reads: [] },
    { category: 'table-lamp', description: 'Bedside lamps, white shade, ceramic base', kind: 'counted_group', quantity: 2, condition: 'good', condition_reason: 'No visible wear', confidence: 'medium', confidence_reason: 'Second lamp seen only in the wide shot', safety: null, seen_in: [{ image: 'F7', box: [0.33, 0.36, 0.33, 0.56] }], reads: [] },
    { category: 'rug', description: 'Patterned area rug', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'No visible stains', confidence: 'low', confidence_reason: 'Could be part of the floor finish', safety: null, seen_in: [{ image: 'F1', box: [0.1, 0.75, 0.45, 0.2] }], reads: [] }
  ], privacy: [], room_note: 'Both sweeps visible. The wall where the television was mounted shows only a bracket.' },
  'Room 112': { lines: [
    { category: 'split-ac', description: 'Wall-mounted split air conditioner, indoor unit', kind: 'single_item', quantity: 1, condition: 'poor', condition_reason: 'Water marks on the wall below the unit', confidence: 'high', confidence_reason: 'Clearly visible with a readable plate', safety: null,
      seen_in: [{ image: 'F1', box: [0.04, 0.06, 0.92, 0.42] }, { image: 'F2', box: [0.1, 0.2, 0.3, 0.4] }, { image: 'L1', box: [0.2, 0.2, 0.6, 0.5] }],
      reads: [{ field: 'make', value: 'LG', image: 'F2', box: [0.16, 0.3, 0.14, 0.18] }, { field: 'model', value: 'S4-Q12JA3QA', image: 'L1', box: [0.44, 0.2, 0.24, 0.05] }, { field: 'serial', value: '310KAP0X2181', image: 'L1', box: [0.44, 0.27, 0.24, 0.05] }] }
  ], privacy: [], room_note: 'Only the wall with the unit was filmed.' },
  'Boardroom': { lines: [
    { category: 'meeting-table', description: 'Round meeting table, light wood top', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'No visible wear', confidence: 'high', confidence_reason: 'Clearly visible', safety: null, seen_in: [{ image: 'F1', box: [0, 0.55, 0.46, 0.45] }], reads: [] },
    { category: 'office-chair', description: 'Mesh office chairs on castors', kind: 'counted_group', quantity: 2, condition: 'good', condition_reason: 'No visible wear', confidence: 'medium', confidence_reason: 'A third chair may be out of shot', safety: null, seen_in: [{ image: 'F1', box: [0.27, 0.4, 0.73, 0.6] }], reads: [] },
    { category: 'projector', description: 'Ceiling-mounted projector, white body', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'Lens clean, body intact', confidence: 'high', confidence_reason: 'Asset tag readable', safety: null, seen_in: [{ image: 'F3', box: [0, 0.05, 1, 0.9] }], reads: [{ field: 'tag', value: 'FA-0412', image: 'F3', box: [0.04, 0.5, 0.3, 0.22] }] }
  ], privacy: [{ image: 'F1', box: [0.7, 0.1, 0.08, 0.12], kind: 'face' }], room_note: 'Table end of the room only.' },
  'Training room': { lines: [
    { category: 'stacking-chair', description: 'Training chairs, wooden seat, metal frame', kind: 'counted_group', quantity: 24, condition: 'good', condition_reason: 'No visible damage', confidence: 'high', confidence_reason: 'Counted across two passes', safety: null, seen_in: [{ image: 'F1', box: [0, 0.42, 1, 0.58] }, { image: 'F2', box: [0.4, 0.4, 0.6, 0.6] }], reads: [{ field: 'serial', value: '88812', image: 'F9', box: null }] },
    { category: 'student-desk', description: 'Student desks, laminate top, metal legs', kind: 'counted_group', quantity: 12, condition: 'fair', condition_reason: 'Chipped laminate on several edges', confidence: 'medium', confidence_reason: 'Rows at the back are partly hidden', safety: null, seen_in: [{ image: 'F1', box: [0, 0.36, 1, 0.6] }], reads: [] },
    { category: 'chalkboard', description: 'Wall-mounted chalkboard', kind: 'single_item', quantity: 1, condition: 'good', condition_reason: 'Surface intact', confidence: 'high', confidence_reason: 'Clearly visible', safety: null, seen_in: [{ image: 'F1', box: [0.38, 0.14, 0.26, 0.17] }], reads: [] }
  ], privacy: [], room_note: 'Front of the classroom seen from the door.' },
  'Corridor 2': { lines: [
    { category: 'fire-extinguisher', description: 'Dry powder fire extinguisher on a wall hook', kind: 'single_item', quantity: 1, condition: 'not_working_or_unsafe', condition_reason: 'Pressure gauge needle in the red zone', confidence: 'high', confidence_reason: 'Gauge readable in a close-up', safety: 'Gauge in the red: it may not discharge', seen_in: [{ image: 'F1', box: [0.3, 0, 0.42, 1] }, { image: 'F3', box: [0.3, 0.3, 0.4, 0.42] }], reads: [] }
  ], privacy: [], room_note: 'Fire point only.' },
  'Plant room': { lines: [
    { category: 'generator', description: 'Petrol generator in an open frame', kind: 'single_item', quantity: 1, condition: 'fair', condition_reason: 'Surface rust on the frame', confidence: 'high', confidence_reason: 'Clearly visible', safety: null, seen_in: [{ image: 'F1', box: [0.06, 0.1, 0.88, 0.78] }], reads: [] }
  ], privacy: [], room_note: 'No inverter or batteries were in view.' }
};
const answerFor = (prompt) => {
  const m = /One room: ([^(]+) \\(/.exec(prompt) || /come from one room: ([^(]+) \\(/.exec(prompt);
  const room = m ? m[1].trim() : '';
  return window.__answers[room] || { lines: [], privacy: [], room_note: 'Nothing recognised.' };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeSample = Object.assign(async (input) => ({ text: 'ok', truncated: false, modelTierApplied: 'default' }), {
  json: async (input, opts = {}) => {
    window.__prompts = (window.__prompts || []).concat([{ prompt: input, images: (opts.images || []).length }]);
    const ans = answerFor(input);
    const text = JSON.stringify(ans);
    for (let i = 1; i <= 3; i++) { await sleep(250); opts.onText && opts.onText({ text: text.slice(0, Math.floor(text.length * i / 3)), delta: '' }); }
    return JSON.parse(text);
  },
  limits: async () => ({ maxPromptBytes: 65536, images: { maxCount: 10, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } })
});
window.__saved = [];
window.claude = { use: async (name) => {
  if (name === 'sample') return fakeSample;
  if (name === 'downloads') return { save: async ({ filename, data }) => { const text = typeof data === 'string' ? data : await data.text(); window.__saved.push({ filename, text }); return { status: 'saved' }; } };
  return null;
} };
`;

const browser = await chromium.launch();
const errors = [];
async function newPage(viewport, persona) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(FAKE);
  if (persona) await ctx.addInitScript(`try{localStorage.setItem('domesday.persona','${persona}')}catch(e){}`);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}
const shot = async (page, name, full = true) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
};
const step = (s) => console.log(`- ${s}`);

const page = await newPage({ width: 1280, height: 900 }, 'tolu');
await page.goto(`${base}#walks`);
await page.getByRole('heading', { name: 'Monthly walk' }).waitFor({ timeout: 20000 });
step('walks page loaded with the seeded site');
await shot(page, '01-walks');

await page.goto(`${base}#capture`);
for (const room of ['Room 204', 'Room 112', 'Boardroom', 'Training room', 'Corridor 2', 'Plant room']) {
  await page.getByRole('button', { name: new RegExp(`^${room}:`) }).click();
  await page.getByRole('button', { name: /Use the sample footage/ }).click();
  await page.getByText(new RegExp(`proposed for ${room}`)).waitFor({ timeout: 90000 });
  if (room === 'Room 112') await shot(page, '02-capture-processed', false);
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  step(`filmed ${room} with sample footage`);
}
await page.getByRole('button', { name: /^Store room B:/ }).click();
await page.getByRole('button', { name: 'Skip this room' }).click();
await page.getByRole('button', { name: 'Locked, no key on site' }).click();
await page.getByRole('button', { name: 'Skip Store room B' }).click();
await page.getByText(/Skipped: Locked, no key on site/).waitFor();
step('skipped Store room B with a reason');
await shot(page, '03-capture-rooms');

const prompts = await page.evaluate(() => window.__prompts.map((p) => ({ images: p.images, len: p.prompt.length })));
step(`recogniser called ${prompts.length} times, images per call: ${prompts.map((p) => p.images).join(', ')}`);

// Review as the capturer first: the separation rule must refuse.
await page.goto(`${base}#review`);
await page.getByRole('heading', { name: 'Review' }).waitFor();
await page.keyboard.press('a');
await page.getByText(/filmed this room, so they can't approve its lines/).waitFor({ timeout: 5000 });
step('capturer refused when approving a line (DMS-054)');

// Switch to the reviewer on this device.
await page.locator('.persona__button').click();
await page.getByRole('menuitemradio', { name: /Chinedu Okafor/ }).click();
await shot(page, '04-review');
let guard = 0;
while (guard++ < 40) {
  const remaining = await page.locator('.queue button .ui-body-strong[style*="700"]').count();
  const lowMed = await page.getByRole('tab', { name: /^(Low|Medium)/ }).count();
  if (remaining === 0 && guard > 1) break;
  const tabHigh = page.getByRole('tab', { name: /^High/ });
  if ((await page.getByText('Low-confidence lines each need').count()) === 0 && (await page.getByText('Medium-confidence lines are decided').count()) === 0 && (await tabHigh.getAttribute('aria-selected')) === 'true') break;
  await page.keyboard.press('a');
  await page.waitForTimeout(250);
  void lowMed;
}
// Approve the high-confidence lines in bulk from the grid.
await page.getByRole('tab', { name: /^High/ }).click();
const gridBtn = page.getByRole('button', { name: /as a grid/ });
if (await gridBtn.count()) {
  await gridBtn.click();
  await shot(page, '05-review-grid');
  await page.getByRole('button', { name: /^Approve the \d+ lines? shown/ }).click();
  await page.waitForTimeout(800);
}
const undecided = await page.evaluate(() => document.body.innerText.match(/(\d+) lines? still needs?/)?.[1] ?? '0');
step(`review done, undecided lines left: ${undecided}`);
await page.getByRole('button', { name: 'Approve walk' }).click();
await page.waitForURL(/#compare/, { timeout: 10000 });
await page.getByRole('heading', { name: /changes? since the walk on 3 October/ }).waitFor();
const headline = await page.getByRole('heading', { level: 1 }).innerText();
step(`walk approved; comparison says "${headline}"`);
await shot(page, '06-compare');

await page.goto(`${base}#reconcile`);
await page.getByRole('heading', { level: 1 }).waitFor();
const confirmAll = page.getByRole('button', { name: /Confirm all \d+ shown/ });
if (await confirmAll.count()) {
  await confirmAll.click();
  await page.waitForTimeout(600);
}
const recon = await page.getByRole('heading', { level: 1 }).innerText();
step(`reconciliation says "${recon}"`);
await shot(page, '07-reconcile');
await page.getByRole('button', { name: 'Export corrections' }).click();
await page.waitForTimeout(300);
const csv = await page.evaluate(() => window.__saved.find((s) => s.filename.endsWith('.csv')));
step(`corrections file ${csv?.filename}: ${csv ? csv.text.split('\n').length - 2 : 0} rows`);

await page.goto(`${base}#report`);
await page.getByRole('button', { name: 'Issue the report' }).click();
await page.getByText(/Issued .* · [0-9A-Z]{4} [0-9A-Z]{4} [0-9A-Z]{4}/).waitFor({ timeout: 10000 });
const code = (await page.locator('.dms-verify__code').first().innerText()).trim();
step(`report issued with code ${code}`);
await shot(page, '08-report');
await page.getByRole('button', { name: 'Download' }).click();
await page.waitForTimeout(300);
const html = await page.evaluate(() => window.__saved.find((s) => s.filename.endsWith('.html'))?.text ?? '');
step(`report file ${html.length} bytes`);

await page.goto(`${base}#verify`);
await page.locator('#verify-code').fill(code.toLowerCase().replace(/ /g, '-'));
await page.getByRole('button', { name: 'Check the code' }).click();
await page.getByText('Matches the issued report').waitFor({ timeout: 5000 });
step('code check: matches the issued report');
await page.locator('#verify-file').setInputFiles({ name: 'report.html', mimeType: 'text/html', buffer: Buffer.from(html) });
await page.getByText('Every word of the file matches the issued report.').waitFor({ timeout: 5000 });
step('file check: matches');
const tampered = html.replace(/Not seen on this walk<\/td><td class="num">(\d+)/, (m, n) => m.replace(n, String(Number(n) + 1)));
await page.locator('#verify-file').setInputFiles({ name: 'report.html', mimeType: 'text/html', buffer: Buffer.from(tampered) });
await page.getByText('Does not match the issued report').waitFor({ timeout: 5000 });
step(`tampered file check: does not match (changed: ${tampered !== html})`);
await shot(page, '09-verify');

// Phone views.
const phone = await newPage({ width: 390, height: 844 }, 'tolu');
await phone.goto(`${base}#capture`);
await phone.getByRole('heading', { name: 'Ikeja branch' }).waitFor();
await shot(phone, '10-phone-capture', false);
await phone.getByRole('button', { name: /^Room 204:/ }).click();
await shot(phone, '11-phone-room', true);
const widths = await phone.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
step(`phone width check: document ${widths.doc}px, window ${widths.win}px`);

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
await browser.close();
server.close();
