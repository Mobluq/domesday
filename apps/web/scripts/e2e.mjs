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
const cameraAnswer = (prompt) => {
  const refs = [...prompt.matchAll(/^(E\\d+): (.*)$/gm)].map((m) => ({ ref: m[1], text: m[2] }));
  return {
    expected: refs.map((r, i) => ({ ref: r.ref, status: /chair|table/i.test(r.text) ? 'visible' : 'not_visible', box: i === 0 ? [0, 0.72, 0.25, 0.28] : [0.25, 0.5, 0.2, 0.3], note: /chair/i.test(r.text) ? 'Two chairs in view' : '' })),
    other: [],
    privacy: [],
    note: 'The camera sees the near end of the table and the door; the projector end is out of shot.',
  };
};
const answerFor = (prompt) => {
  if (prompt.includes('checking a still from a fixed CCTV camera')) return cameraAnswer(prompt);
  const m = /One room: ([^(]+) \\(/.exec(prompt) || /come from one room: ([^(]+) \\(/.exec(prompt);
  const room = m ? m[1].trim() : '';
  return window.__answers[room] || { lines: [], privacy: [], room_note: 'Nothing recognised.' };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeSample = Object.assign(async (input, opts = {}) => {
  if (String(input).includes('inventory assistant inside Domesday')) {
    window.__askPrompts = (window.__askPrompts || []).concat([{ prompt: input, tier: opts.modelTier }]);
    const text = 'Six register lines were not seen on this walk, with a book value of ₦3,970,000.\\n- FA-1043 Television, Sony 43-inch, Room 204\\n- FA-0391 Laptop, HP ProBook 450, Room 112';
    for (let i = 1; i <= 4; i++) { await sleep(120); opts.onText && opts.onText({ text: text.slice(0, Math.floor(text.length * i / 4)), delta: '' }); }
    return { text, truncated: false };
  }
  return { text: 'ok', truncated: false, modelTierApplied: 'default' };
}, {
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
async function newPage(viewport, persona, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(FAKE);
  if (persona) await ctx.addInitScript(`try{localStorage.setItem('domesday.persona','${persona}')}catch(e){}`);
  // The first-run tour is tested on its own; elsewhere it is marked as seen.
  if (!opts.tour) await ctx.addInitScript(`try{for (const id of ['tolu','chinedu','ifeoma','ada','folu']) localStorage.setItem('domesday.tour.v1.'+id,'1')}catch(e){}`);
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

// Ask Domesday: one tap on a suggested question.
await page.getByRole('button', { name: 'Ask about the inventory' }).click();
await page.getByRole('dialog', { name: 'Ask about the inventory' }).waitFor();
await shot(page, '22-ask-empty', false);
await page.locator('.ask__idea').first().click();
await page.locator('.ask__a').filter({ hasText: 'were not seen on this walk' }).waitFor({ timeout: 10000 });
await page.locator('.ask__a[data-streaming]').waitFor({ state: 'detached', timeout: 10000 });
const asked = await page.evaluate(() => window.__askPrompts?.[0] ?? { prompt: '', tier: null });
step(`assistant answered on the ${asked.tier} tier; its prompt carried the register (${asked.prompt.includes('FIXED ASSET REGISTER')}), numbered lines (${/Line \d{3} \|/.test(asked.prompt)}) and the not-seen list (${asked.prompt.includes('Not seen:')})`);
await shot(page, '23-ask-answer', false);
await page.getByRole('dialog', { name: 'Ask about the inventory' }).getByRole('button', { name: 'Close' }).click();

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

// Cameras: a check with CAM 01's sample still, then the hint on the comparison's not-seen rows.
await page.goto(`${base}#cameras`);
await page.getByRole('heading', { name: 'Camera checks between walks' }).waitFor();
await page.locator('section[aria-label^="CAM 01"]').getByRole('button', { name: 'Check now with the sample still' }).click();
await page.locator('section[aria-label^="CAM 01"]').getByText('Visible', { exact: true }).first().waitFor({ timeout: 20000 });
const camCounts = await page.locator('section[aria-label^="CAM 01"]').evaluate((el) => ({ visible: el.querySelectorAll('.dms-chip').length, text: el.innerText.includes('not visible from this camera') || el.innerText.includes('Not visible from this camera') }));
step(`camera check on CAM 01: ${camCounts.visible} chips, says "not visible from this camera" for some: ${camCounts.text}`);
await shot(page, '12-cameras');
await page.goto(`${base}#compare`);
await page.getByRole('heading', { name: /changes? since the walk on 3 October/ }).waitFor();
const hints = await page.locator('.cam-hint').count();
step(`comparison shows ${hints} camera hints on not-seen rows`);

// Start the next walk from the walks page.
await page.goto(`${base}#walks`);
await page.getByRole('button', { name: 'Start the next walk' }).click();
await page.getByRole('heading', { name: 'Monthly walk' }).waitFor({ timeout: 10000 });
step('next walk started; the approved walk is now the one it is compared against');
await shot(page, '13-next-walk');

// Phone views.
const phone = await newPage({ width: 390, height: 844 }, 'tolu');
await phone.goto(`${base}#capture`);
await phone.getByRole('heading', { name: 'Ikeja branch' }).waitFor();
await shot(phone, '10-phone-capture', false);
await phone.getByRole('button', { name: /^Room 204:/ }).click();
await shot(phone, '11-phone-room', true);
const widths = await phone.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
step(`phone width check: document ${widths.doc}px, window ${widths.win}px`);

// Guided capture on the phone: one room with the sample footage, then the next room, then hold to exit.
await phone.goto(`${base}#guided`);
await phone.getByRole('heading', { name: 'Room 204' }).waitFor();
await shot(phone, '14-guided-room', false);
await phone.getByRole('button', { name: /Use the sample footage/ }).click();
await phone.getByText(/\d+ items? found/).waitFor({ timeout: 90000 });
await shot(phone, '15-guided-done', false);
await phone.getByRole('button', { name: /Next room: Room 112/ }).click();
await phone.getByRole('heading', { name: 'Room 112' }).waitFor();
step('guided capture: Room 204 filmed and read, moved on to Room 112');
const gw = await phone.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
step(`guided width check: document ${gw.doc}px, window ${gw.win}px`);
const exit = phone.getByRole('button', { name: 'Hold to leave guided capture' });
await exit.hover();
await phone.mouse.down();
await phone.waitForTimeout(400);
await phone.mouse.up();
const stillGuided = phone.url().endsWith('#guided');
await exit.hover();
await phone.mouse.down();
await phone.waitForTimeout(1800);
await phone.mouse.up();
await phone.waitForURL(/#capture/, { timeout: 5000 });
step(`hold to exit: a short press stays (${stillGuided}), a long hold leaves`);

// The first-run tour, for a reviewer who has not seen it.
const fresh = await newPage({ width: 1280, height: 900 }, 'chinedu', { tour: true });
await fresh.goto(`${base}#walks`);
await fresh.getByRole('dialog').getByText('Every line waits for a person').waitFor({ timeout: 20000 });
await shot(fresh, '16-tour', false);
await fresh.getByRole('button', { name: 'Next' }).click();
await fresh.getByRole('dialog').getByText('Fix what the AI got wrong').waitFor();
await fresh.getByRole('button', { name: 'Skip' }).click();
await fresh.getByRole('dialog').waitFor({ state: 'detached' });
await fresh.reload();
await fresh.getByRole('heading', { name: 'Monthly walk' }).waitFor();
const tourAgain = await fresh.getByRole('dialog').count();
step(`tour shown once for a new reviewer, not again after skipping (${tourAgain === 0})`);

// A buyer's own site: clear the demo, then the setup wizard with a register import.
await fresh.goto(`${base}#site`);
await fresh.getByRole('heading', { name: 'Site setup' }).waitFor();
await shot(fresh, '17-site-setup');
await fresh.getByRole('button', { name: 'Clear the demo and set up my own site' }).click();
await fresh.getByRole('button', { name: 'Clear everything' }).click();
await fresh.getByRole('button', { name: /Set up your own site/ }).waitFor({ timeout: 20000 });
await shot(fresh, '18-empty');
await fresh.getByRole('button', { name: /Set up your own site/ }).click();
await fresh.locator('#setup-site').fill('Victoria Island office');
await fresh.locator('#setup-you').fill('Folu Oyebanjo');
await fresh.getByRole('button', { name: 'Next' }).click();
await fresh.getByRole('button', { name: 'Reception' }).click();
await fresh.locator('#room-name').fill('Room 112');
await fresh.locator('#room-floor').fill('Floor 1');
await fresh.getByRole('button', { name: 'Add', exact: true }).click();
await shot(fresh, '19-wizard-rooms');
await fresh.getByRole('button', { name: 'Next' }).click();
await fresh.locator('#person-name').fill('Ada Obi');
await fresh.getByRole('button', { name: 'Add', exact: true }).click();
await fresh.getByRole('button', { name: 'Next' }).click();
const template = ['Asset ID,Description,Category,Location,Quantity,Cost (NGN),Net book value (NGN),Acquired,Tag code,Serial number', 'FA-0001,"Split air conditioner, 1.5 HP",Split air conditioner,Boardroom,1,"450,000","380,000",12/04/2023,FA-0001,', 'FA-0003,"Laptop, 14-inch",Laptop,Room 112,1,"1,200,000","800,000",15/08/2024,FA-0003,5CD1234XYZ', 'FA-0009,Reception sofa,Sofa,Reception,1,"300,000","250,000",01/02/2024,,'].join('\r\n');
await fresh.locator('#register-file').setInputFiles({ name: 'register.csv', mimeType: 'text/csv', buffer: Buffer.from(template) });
await fresh.getByText('register.csv: 3 lines').waitFor();
await shot(fresh, '20-wizard-register');
await fresh.getByRole('button', { name: 'Use this register' }).click();
await fresh.getByRole('button', { name: 'Next' }).click();
await fresh.getByRole('button', { name: 'Create the site' }).click();
await fresh.getByRole('heading', { name: 'First walk' }).waitFor({ timeout: 20000 });
if (await fresh.getByRole('dialog').count()) await fresh.getByRole('button', { name: 'Skip' }).click();
const siteText = await fresh.locator('.page-head').innerText();
step(`own site created: ${siteText.split('\n')[0]}`);
await shot(fresh, '21-own-site');
await fresh.goto(`${base}#compare`);
await fresh.getByRole('heading', { name: 'Nothing to compare with yet' }).waitFor();
step('first walk: comparison explains there is nothing to compare with yet');

console.log(`\nconsole errors: ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
await browser.close();
server.close();
