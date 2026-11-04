// Writes apps/web/public/seed.json: the demo site, its register, the approved walk of
// 3 October 2026 (demo history) and an empty current walk. The same file seeds the
// shared store on first publish and backs "Reset demo" in the app.
//
//   node apps/web/scripts/make-seed.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const naira = (n) => Math.round(n * 100);

const SITE_ID = 'ikeja';
const PREVIOUS = 'w-2026-10-03';
const CURRENT = 'w-current';

const categories = [
  ['television', 'Television', 'televisions'],
  ['bed', 'Bed', 'beds'],
  ['armchair', 'Armchair', 'armchairs'],
  ['sofa', 'Sofa', 'sofas'],
  ['framed-art', 'Framed print or artwork', 'framed prints'],
  ['floor-lamp', 'Floor lamp', 'floor lamps'],
  ['table-lamp', 'Table or bedside lamp', 'lamps'],
  ['side-table', 'Side or bedside table', 'side tables'],
  ['wardrobe', 'Wardrobe', 'wardrobes'],
  ['mirror', 'Mirror', 'mirrors'],
  ['rug', 'Rug', 'rugs'],
  ['mini-fridge', 'Mini fridge', 'mini fridges'],
  ['refrigerator', 'Refrigerator', 'refrigerators'],
  ['split-ac', 'Split air conditioner', 'air conditioners'],
  ['standing-fan', 'Standing fan', 'standing fans'],
  ['ceiling-fan', 'Ceiling fan', 'ceiling fans'],
  ['meeting-table', 'Meeting or conference table', 'meeting tables'],
  ['desk', 'Desk', 'desks'],
  ['student-desk', 'Student or training desk', 'student desks'],
  ['office-chair', 'Office chair', 'office chairs'],
  ['stacking-chair', 'Stacking or training chair', 'chairs'],
  ['chalkboard', 'Chalkboard or whiteboard', 'boards'],
  ['projector', 'Projector', 'projectors'],
  ['projector-screen', 'Projector screen', 'projector screens'],
  ['laptop', 'Laptop', 'laptops'],
  ['desktop-computer', 'Desktop computer', 'desktop computers'],
  ['monitor', 'Computer monitor', 'monitors'],
  ['printer', 'Printer', 'printers'],
  ['telephone', 'Telephone', 'telephones'],
  ['safe', 'Safe', 'safes'],
  ['water-dispenser', 'Water dispenser', 'water dispensers'],
  ['microwave', 'Microwave', 'microwaves'],
  ['fire-extinguisher', 'Fire extinguisher', 'fire extinguishers'],
  ['generator', 'Generator', 'generators'],
  ['inverter', 'Inverter', 'inverters'],
  ['solar-battery', 'Solar battery', 'solar batteries'],
  ['cctv-camera', 'CCTV camera', 'CCTV cameras'],
  ['network-equipment', 'Router, switch or access point', 'network devices'],
  ['filing-cabinet', 'Filing cabinet or cupboard', 'cabinets'],
  ['shelving', 'Shelving', 'shelving units'],
  ['other', 'Other asset', 'other assets'],
].map(([id, name, plural]) => ({ id, name, plural }));

const sample = (name, seconds, labelShots = []) => ({
  video: `media/samples/${name}.mp4`,
  webm: `media/samples/${name}.webm`,
  poster: `media/samples/${name}.jpg`,
  labelShots,
  seconds,
});

const rooms = [
  { id: 'r-204', name: 'Room 204', floor: 'Floor 2', note: 'Guest twin room', sample: sample('room-204', 17.3) },
  { id: 'r-112', name: 'Room 112', floor: 'Floor 1', note: 'Office', sample: sample('room-112', 8.0, ['media/samples/room-112-label.jpg']) },
  { id: 'boardroom', name: 'Boardroom', floor: 'Floor 1', note: 'Meeting room', sample: sample('boardroom', 7.4) },
  { id: 'training', name: 'Training room', floor: 'Floor 1', note: 'Classroom layout', sample: sample('training-room', 6.2) },
  { id: 'corridor-2', name: 'Corridor 2', floor: 'Floor 2', note: 'Fire point by the stairs', sample: sample('corridor-2', 6.2) },
  { id: 'plant', name: 'Plant room', floor: 'Ground floor', note: 'Generator and inverter', sample: sample('plant-room', 5.0) },
  { id: 'store-b', name: 'Store room B', floor: 'Floor 2', note: 'Usually locked', sample: null },
];

const people = [
  { id: 'tolu', name: 'Tolu Adeyemi', initials: 'TA', role: 'site_manager', roleLabel: 'Site manager', duty: 'Films the walks' },
  { id: 'chinedu', name: 'Chinedu Okafor', initials: 'CO', role: 'reviewer', roleLabel: 'Reviewer', duty: 'Reviews and approves' },
  { id: 'ifeoma', name: 'Ifeoma Nwosu', initials: 'IN', role: 'financial_controller', roleLabel: 'Financial controller', duty: 'Reconciles and issues reports' },
];

const register = [
  ['FA-1043', 'Television, Sony 43-inch', 'television', 'r-204', 'Room 204', 1, 450000, 380000, '2023-04-12', {}],
  ['FA-1075', 'Bed, king size', 'bed', 'r-204', 'Room 204', 1, 420000, 310000, '2022-11-02', {}],
  ['FA-1078', 'Armchair, upholstered', 'armchair', 'r-204', 'Room 204', 1, 190000, 145000, '2022-11-02', {}],
  ['FA-1081', 'Framed print', 'framed-art', 'r-204', 'Room 204', 1, 52000, 38000, '2022-11-02', {}],
  ['FA-1102', 'Bedside lamps (2)', 'table-lamp', 'r-204', 'Room 204', 2, 64000, 48000, '2022-11-02', {}],
  ['FA-0450', 'Split air conditioner, LG 1.5 HP', 'split-ac', 'r-112', 'Room 112', 1, 560000, 420000, '2023-01-20', { serial: '310KAP0X2181' }],
  ['FA-0391', 'Laptop, HP ProBook 450', 'laptop', 'r-112', 'Room 112', 1, 980000, 620000, '2023-06-05', { serial: '5CD2149XQ7' }],
  ['FA-0301', 'Meeting table, 8-seater', 'meeting-table', 'boardroom', 'Boardroom', 1, 340000, 260000, '2022-08-15', {}],
  ['FA-0310', 'Office chairs, mesh (2)', 'office-chair', 'boardroom', 'Boardroom', 2, 180000, 130000, '2022-08-15', {}],
  ['FA-0412', 'Projector, Epson EB-X49', 'projector', 'training', 'Training room', 1, 720000, 540000, '2023-02-27', { tagCode: 'FA-0412', serial: 'X7D20488' }],
  ['FA-0877', 'Training chairs (32)', 'stacking-chair', 'training', 'Training room', 32, 1440000, 1120000, '2022-05-09', {}],
  ['FA-0880', 'Student desks (16)', 'student-desk', 'training', 'Training room', 16, 1280000, 960000, '2022-05-09', {}],
  ['FA-0890', 'Chalkboard', 'chalkboard', 'training', 'Training room', 1, 95000, 75000, '2022-05-09', {}],
  ['FA-0233', 'Fire extinguisher, 9 kg dry powder', 'fire-extinguisher', 'corridor-2', 'Corridor 2', 1, 48000, 42000, '2024-03-01', {}],
  ['FA-0101', 'Generator, 7.5 kVA petrol', 'generator', 'plant', 'Plant room', 1, 1900000, 1350000, '2021-12-10', {}],
  ['FA-0105', 'Inverter, 5 kVA', 'inverter', 'plant', 'Plant room', 1, 1150000, 850000, '2023-09-18', {}],
  ['FA-0106', 'Solar batteries, 200 Ah (4)', 'solar-battery', 'plant', 'Plant room', 4, 2000000, 1600000, '2023-09-18', {}],
  ['FA-0601', 'Water dispenser', 'water-dispenser', 'store-b', 'Store room B', 1, 125000, 95000, '2022-03-03', {}],
  ['FA-0602', 'Mini fridge', 'mini-fridge', 'store-b', 'Store room B', 1, 170000, 135000, '2022-03-03', {}],
  ['FA-0603', 'Standing fans (3)', 'standing-fan', 'store-b', 'Store room B', 3, 90000, 66000, '2022-03-03', {}],
  ['FA-0604', 'Office chairs, spare (4)', 'office-chair', 'store-b', 'Store room B', 4, 320000, 240000, '2022-08-15', {}],
  ['FA-0605', 'Printer, laser', 'printer', 'store-b', 'Store room B', 1, 240000, 180000, '2023-03-14', {}],
  ['FA-0606', 'Safe, digital', 'safe', 'store-b', 'Store room B', 1, 150000, 110000, '2022-03-03', {}],
].map(([registerId, description, categoryId, roomId, locationLabel, quantity, cost, book, acquired, ids]) => ({
  registerId,
  description,
  categoryId,
  roomId,
  locationLabel,
  quantity,
  costKobo: naira(cost),
  bookValueKobo: naira(book),
  acquired,
  tagCode: ids.tagCode ?? null,
  serial: ids.serial ?? null,
}));

// The approved walk of 3 October 2026: demo history.
const at = (hhmm) => `2026-10-03T${hhmm}:00+01:00`;
const file = (name) => ({ kind: 'file', path: `media/walk-2026-10-03/${name}.jpg` });
const frame = (id, name, t, extra = {}) => ({ id, ref: file(name), t, w: 960, h: 720, ...extra });

const previousRooms = {
  'r-204': { at: '09:58', frames: [frame('f-tv', 'television', 51.2), frame('f-bed', 'bed', 12.4), frame('f-armchair', 'armchair', 22.0), frame('f-print', 'framed-print', 30.6), frame('f-lamps', 'bedside-lamps', 41.8)] },
  'r-112': { at: '10:06', frames: [frame('f-ac', 'air-conditioner', 11.8), frame('f-badge', 'ac-badge', 13.0)], labelShots: [frame('l-ac', 'ac-label', null, { label: true })] },
  boardroom: { at: '10:12', frames: [frame('f-meeting', 'meeting-room', 6.4)] },
  training: { at: '10:18', frames: [frame('f-training', 'training-room', 20.3), frame('f-projector', 'projector', 41.5)] },
  'corridor-2': { at: '10:27', frames: [frame('f-ext', 'extinguisher', 31.0)] },
  plant: { at: '10:31', frames: [frame('f-gen', 'generator', 8.2)] },
  'store-b': { at: '10:38', frames: [] },
};

const read = (value, frameId, box) => ({ value, source: 'read', frameId, box });
let order = 0;
const prevLine = (id, roomId, categoryId, description, opts) => {
  order += 1;
  const quantity = opts.quantity ?? 1;
  return {
    id,
    walkId: PREVIOUS,
    roomId,
    createdAt: `2026-10-03T13:${String(order).padStart(2, '0')}:00+01:00`,
    kind: quantity > 1 ? 'counted_group' : 'single_item',
    quantity,
    categoryId,
    description,
    make: opts.make ?? null,
    model: opts.model ?? null,
    serial: opts.serial ?? null,
    tagCode: opts.tagCode ?? null,
    condition: opts.condition ?? 'good',
    conditionReason: opts.reason ?? 'No visible wear or damage',
    band: 'high',
    bandReason: null,
    safety: null,
    evidence: opts.evidence ?? [],
    proposedBy: { kind: 'demo-history', at: '2026-10-03T13:00:00+01:00' },
    status: 'accepted',
    decision: { kind: opts.edited ? 'edit' : 'accept', by: 'chinedu', at: `2026-10-03T14:${String(order).padStart(2, '0')}:00+01:00`, reason: null, bulk: false },
    history: [],
    notes: [],
    registerId: opts.registerId ?? null,
    version: 1,
  };
};

const previousLines = [
  prevLine('p-204-tv', 'r-204', 'television', 'Flat-screen television on a wall bracket', { registerId: 'FA-1043', make: read('Sony', 'f-tv', [0.47, 0.82, 0.07, 0.04]), evidence: [{ frameId: 'f-tv', box: [0.2, 0.15, 0.6, 0.65] }] }),
  prevLine('p-204-bed', 'r-204', 'bed', 'King-size bed with upholstered headboard', { registerId: 'FA-1075', evidence: [{ frameId: 'f-bed', box: [0.0, 0.22, 1.0, 0.78] }] }),
  prevLine('p-204-armchair', 'r-204', 'armchair', 'Upholstered armchair, cream fabric, dark wood frame', { registerId: 'FA-1078', evidence: [{ frameId: 'f-armchair', box: [0.16, 0.26, 0.68, 0.64] }] }),
  prevLine('p-204-print', 'r-204', 'framed-art', 'Framed print of a white lily', { registerId: 'FA-1081', evidence: [{ frameId: 'f-print', box: [0.32, 0.0, 0.42, 0.86] }] }),
  prevLine('p-204-lamps', 'r-204', 'table-lamp', 'Bedside lamps, white shade, ceramic base', { registerId: 'FA-1102', quantity: 2, evidence: [{ frameId: 'f-lamps', box: [0.33, 0.36, 0.33, 0.56] }] }),
  prevLine('p-112-ac', 'r-112', 'split-ac', 'Wall-mounted split air conditioner, indoor unit', {
    registerId: 'FA-0450',
    make: read('LG', 'f-badge', [0.16, 0.24, 0.14, 0.16]),
    model: read('S4-Q12JA3QA', 'l-ac', [0.45, 0.19, 0.22, 0.05]),
    serial: read('310KAP0X2181', 'l-ac', [0.45, 0.25, 0.22, 0.05]),
    evidence: [{ frameId: 'f-ac', box: [0.03, 0.08, 0.94, 0.42] }, { frameId: 'f-badge', box: [0.16, 0.24, 0.14, 0.16] }, { frameId: 'l-ac', box: null }],
  }),
  prevLine('p-board-table', 'boardroom', 'meeting-table', 'Round meeting table, light wood top', { registerId: 'FA-0301', evidence: [{ frameId: 'f-meeting', box: [0.0, 0.56, 0.46, 0.44] }] }),
  prevLine('p-board-chairs', 'boardroom', 'office-chair', 'Mesh office chairs on castors', { registerId: 'FA-0310', quantity: 2, evidence: [{ frameId: 'f-meeting', box: [0.27, 0.4, 0.73, 0.6] }] }),
  prevLine('p-train-projector', 'training', 'projector', 'Ceiling-mounted projector, white body', { registerId: 'FA-0412', tagCode: read('FA-0412', 'f-projector', [0.05, 0.52, 0.29, 0.2]), evidence: [{ frameId: 'f-projector', box: [0.0, 0.08, 0.98, 0.84] }] }),
  prevLine('p-train-chairs', 'training', 'stacking-chair', 'Training chairs, wooden seat, metal frame', { registerId: 'FA-0877', quantity: 32, evidence: [{ frameId: 'f-training', box: [0.0, 0.42, 1.0, 0.58] }] }),
  prevLine('p-train-desks', 'training', 'student-desk', 'Student desks, laminate top, metal legs', { registerId: 'FA-0880', quantity: 16, condition: 'fair', reason: 'Laminate chipped on several edges', evidence: [{ frameId: 'f-training', box: [0.0, 0.36, 1.0, 0.6] }] }),
  prevLine('p-train-board', 'training', 'chalkboard', 'Wall-mounted chalkboard', { registerId: 'FA-0890', evidence: [{ frameId: 'f-training', box: [0.36, 0.13, 0.28, 0.17] }] }),
  prevLine('p-c2-ext', 'corridor-2', 'fire-extinguisher', 'Dry powder fire extinguisher on a wall hook', { registerId: 'FA-0233', reason: 'Gauge in the green, seal and tag intact', evidence: [{ frameId: 'f-ext', box: [0.3, 0.0, 0.42, 1.0] }] }),
  prevLine('p-plant-gen', 'plant', 'generator', 'Petrol generator in an open frame', { registerId: 'FA-0101', condition: 'fair', reason: 'Surface rust on the frame', evidence: [{ frameId: 'f-gen', box: [0.06, 0.1, 0.88, 0.78] }] }),
  prevLine('p-sb-dispenser', 'store-b', 'water-dispenser', 'Water dispenser, hot and cold', { registerId: 'FA-0601' }),
  prevLine('p-sb-fridge', 'store-b', 'mini-fridge', 'Mini fridge, single door', { registerId: 'FA-0602' }),
  prevLine('p-sb-fans', 'store-b', 'standing-fan', 'Standing fans', { registerId: 'FA-0603', quantity: 3 }),
  prevLine('p-sb-chairs', 'store-b', 'office-chair', 'Spare mesh office chairs', { registerId: 'FA-0604', quantity: 4 }),
  prevLine('p-sb-printer', 'store-b', 'printer', 'Laser printer', { registerId: 'FA-0605' }),
  prevLine('p-sb-safe', 'store-b', 'safe', 'Digital safe, floor-standing', { registerId: 'FA-0606' }),
];

const docs = {};
docs['site/main'] = {
  id: SITE_ID,
  name: 'Ikeja branch',
  city: 'Lagos',
  currency: 'NGN',
  thresholdKobo: naira(100000),
  separationRule: true,
  rooms,
  people,
  categories,
  currentWalkId: CURRENT,
  previousWalkId: PREVIOUS,
  registerImportedAt: '2026-10-28',
  demo: true,
  cameras: [
    { id: 'cam-01', name: 'CAM 01', roomId: 'boardroom', brand: 'IP camera on the NVR, channel 1', connection: 'gateway', schedule: 'nightly', sampleStill: 'media/cctv/cam-01-boardroom.jpg' },
    { id: 'cam-02', name: 'CAM 02', roomId: 'plant', brand: 'IP camera on the NVR, channel 2', connection: 'gateway', schedule: 'nightly', sampleStill: 'media/cctv/cam-02-plant-room.jpg' },
    { id: 'cam-03', name: 'CAM 03', roomId: 'training', brand: 'IP camera on the NVR, channel 3', connection: 'gateway', schedule: 'nightly', sampleStill: 'media/cctv/cam-03-training-room.jpg' },
  ],
};
docs['register/main'] = {
  importedAt: '2026-10-28T11:20:00+01:00',
  importedBy: 'ifeoma',
  fileName: 'fixed-asset-register-ikeja-2026-10-28.csv',
  lines: register,
};
docs[`walks/${PREVIOUS}`] = {
  id: PREVIOUS,
  siteId: SITE_ID,
  label: 'Monthly walk',
  status: 'approved',
  startedAt: at('09:58'),
  finishedAt: at('10:41'),
  capturedBy: ['tolu'],
  approvedAt: '2026-10-03T15:20:00+01:00',
  approvedBy: 'chinedu',
  previousWalkId: null,
  demoHistory: true,
  events: [],
};
for (const room of rooms) {
  const p = previousRooms[room.id];
  docs[`walks/${PREVIOUS}/rooms/${room.id}`] = {
    roomId: room.id,
    status: 'filmed',
    skipReason: null,
    filmedBy: 'tolu',
    filmedAt: at(p.at),
    clip: null,
    frames: p.frames,
    labelShots: p.labelShots ?? [],
    analysis: { status: 'done', note: 'Demo history: the clip itself is not included.' },
    updatedAt: at(p.at),
  };
}
for (const line of previousLines) docs[`walks/${PREVIOUS}/lines/${line.id}`] = line;

docs[`walks/${CURRENT}`] = {
  id: CURRENT,
  siteId: SITE_ID,
  label: 'Monthly walk',
  status: 'capturing',
  startedAt: null,
  finishedAt: null,
  capturedBy: [],
  approvedAt: null,
  approvedBy: null,
  previousWalkId: PREVIOUS,
  demoHistory: false,
  events: [],
};
for (const room of rooms) {
  docs[`walks/${CURRENT}/rooms/${room.id}`] = {
    roomId: room.id,
    status: 'not_started',
    skipReason: null,
    filmedBy: null,
    filmedAt: null,
    clip: null,
    frames: [],
    labelShots: [],
    analysis: { status: 'idle' },
    updatedAt: '2026-11-04T00:00:00+01:00',
  };
}

const out = join(here, '..', 'public', 'seed.json');
writeFileSync(out, `${JSON.stringify({ version: 1, currentWalkId: CURRENT, previousWalkId: PREVIOUS, docs }, null, 1)}\n`);
console.log(`Wrote ${Object.keys(docs).length} documents to ${out}`);
