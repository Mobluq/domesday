import { describe, expect, it } from 'vitest';
import { buildPrompt, parseRecognition, proposalsToLines, type PromptFrame } from '../src/ai/recognise';
import type { Category, RoomDef } from '../src/data/types';

const categories: Category[] = [
  { id: 'split-ac', name: 'Split air conditioner', plural: 'air conditioners' },
  { id: 'stacking-chair', name: 'Stacking or training chair', plural: 'chairs' },
  { id: 'fire-extinguisher', name: 'Fire extinguisher', plural: 'fire extinguishers' },
  { id: 'other', name: 'Other asset', plural: 'other assets' },
];
const frames: PromptFrame[] = [
  { ref: 'F1', frameId: 'r112-a-f1', t: 1.2, label: false },
  { ref: 'F2', frameId: 'r112-a-f2', t: 4.5, label: false },
  { ref: 'L1', frameId: 'r112-a-l1', t: null, label: true },
];
const room: RoomDef = { id: 'r-112', name: 'Room 112', floor: 'Floor 1', note: 'Office' };

describe('recognition prompt and answer checks', () => {
  it('Asks for the tenant categories only and lists every image in order', () => {
    const prompt = buildPrompt({ siteName: 'Ikeja branch', room, frames, categories, learned: ['"Sofa" was relabelled "Armchair".'] });
    expect(prompt).toContain('F1: video frame at 00:01.2');
    expect(prompt).toContain('L1: label shot');
    expect(prompt).toContain('split-ac: Split air conditioner');
    expect(prompt).toContain('Never call anything missing, lost or stolen.');
    expect(prompt).toContain('Follow these lessons:');
  });

  it('Keeps a serial only when it comes with the image and region it was read from (DMS-033)', () => {
    const r = parseRecognition(
      {
        lines: [
          {
            category: 'split-ac',
            description: 'Split unit',
            quantity: 1,
            condition: 'poor',
            condition_reason: 'Water marks',
            confidence: 'high',
            seen_in: [{ image: 'F1', box: [0.1, 0.1, 0.8, 0.4] }],
            reads: [
              { field: 'serial', value: '310KAP0X2181', image: 'L1', box: [0.4, 0.2, 0.2, 0.05] },
              { field: 'model', value: 'S4-Q12', image: 'L1' },
            ],
          },
        ],
      },
      frames,
      categories,
    );
    const p = r.proposals[0];
    expect(p?.serial).toMatchObject({ value: '310KAP0X2181', frameId: 'r112-a-l1', source: 'read' });
    expect(p?.model).toBeNull();
    expect(p?.notes.join(' ')).toContain('no readable source');
  });

  it('Corrects what breaks the rules and never raises confidence', () => {
    const r = parseRecognition(
      {
        lines: [
          { category: 'sofa-bed', description: 'Something', quantity: 1, condition: 'unsafe', confidence: 'high', seen_in: [{ image: 'F9' }] },
          { category: 'stacking-chair', description: 'Chairs', quantity: 24, condition: 'good', confidence: 'high', seen_in: [{ image: 'F2', box: [10, 40, 80, 50] }] },
          { category: 'fire-extinguisher', description: 'Extinguisher', quantity: 1, condition: 'not_working_or_unsafe', confidence: 'high', safety: 'Gauge in the red', seen_in: [{ image: 'F1', box: [0.3, 0, 0.4, 1] }] },
        ],
        privacy: [{ image: 'F2', box: [0.5, 0.1, 0.1, 0.1], kind: 'face' }, { image: 'F7', box: [0, 0, 0.1, 0.1] }],
      },
      frames,
      categories,
    );
    const [other, chairs, ext] = r.proposals;
    expect(other).toMatchObject({ categoryId: 'other', condition: 'not_working_or_unsafe', band: 'medium' });
    expect(other?.evidence[0]?.frameId).toBe('r112-a-f1');
    expect(chairs).toMatchObject({ kind: 'counted_group', quantity: 24, band: 'medium' });
    expect(chairs?.evidence[0]?.box).toEqual([0.1, 0.4, 0.8, 0.5]);
    expect(ext).toMatchObject({ band: 'medium', safety: 'Gauge in the red' });
    expect(r.privacy.get('r112-a-f2')).toHaveLength(1);
    expect(r.privacy.size).toBe(1);
  });

  it('Turns proposals into lines waiting for a person, in a stable order', () => {
    const r = parseRecognition({ lines: [{ category: 'split-ac', description: 'Unit', quantity: 1, condition: 'good', confidence: 'low', seen_in: [{ image: 'F1' }] }] }, frames, categories);
    let n = 0;
    const lines = proposalsToLines(r, { walkId: 'w', roomId: 'r-112', model: 'Claude', at: '2026-11-04T09:00:00.000Z', idFor: () => `l${++n}` });
    expect(lines[0]).toMatchObject({ id: 'l1', status: 'proposed', decision: null, band: 'low', proposedBy: { kind: 'recogniser' } });
  });
});
