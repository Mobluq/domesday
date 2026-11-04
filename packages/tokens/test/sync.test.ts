import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTokens } from '../src/build';
import { SyncError, cssVariablesRead, fromDesignSystem, typographyCss, type DesignSystemTokens } from '../src/sync';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const sample = (): DesignSystemTokens => ({
  color: {
    tokens: [
      { name: 'paper-50', value: '#f5f6f3' },
      { name: 'ink-900', value: '#141815' },
      { name: 'surface', value: { light: '{paper-50}', dark: '#0e1210' } },
      { name: 'surface-inverse', value: { light: '{ink-900}', dark: '{paper-50}' } },
      { name: 'not-seen-mark', value: { light: '#bf7a0c', dark: '#e8a23a' } },
      { name: 'camera-record', value: '#ff3b2f' },
      { name: 'button-primary', value: { light: '{surface-inverse}', dark: '{surface-inverse}' } },
    ],
  },
  type: {
    families: { sans: '"Atkinson Hyperlegible Next", system-ui, sans-serif' },
    groups: [{ name: 'Interface', family: 'sans', styles: [{ name: 'ui-body', fontSize: '15px', lineHeight: '22px', fontWeight: 400 }] }],
  },
  spacing: { tokens: [{ name: 'space-4', value: '16px' }] },
  radius: { tokens: [{ name: 'radius-s', value: '4px' }] },
  shadow: { tokens: [{ name: 'shadow-popover', value: { light: '0 1px 2px rgba(0,0,0,0.1)', dark: '0 1px 2px rgba(0,0,0,0.5)' } }] },
});

describe('design system sync', () => {
  it('Sorts design system colours into primitive, semantic and component layers', () => {
    const t = fromDesignSystem(sample());
    expect(t.primitive.color).toEqual({ 'paper-50': '#f5f6f3', 'ink-900': '#141815' });
    expect(t.semantic.color?.surface).toEqual({ light: '{primitive.color.paper-50}', dark: '#0e1210' });
    expect(t.semantic.color?.['camera-record']).toEqual({ light: '#ff3b2f', dark: '#ff3b2f' });
    expect(t.component.button).toEqual({ primary: '{semantic.color.surface-inverse}' });
    expect(t.primitive.space).toEqual({ '4': '16px' });
    expect(t.semantic.shadow?.popover).toEqual({ light: '0 1px 2px rgba(0,0,0,0.1)', dark: '0 1px 2px rgba(0,0,0,0.5)' });
  });

  it('Builds into the same CSS names the design system uses', () => {
    const { css } = buildTokens(fromDesignSystem(sample()));
    for (const name of ['--paper-50', '--surface', '--not-seen-mark', '--camera-record', '--button-primary', '--space-4', '--radius-s', '--font-sans', '--shadow-popover']) {
      expect(css).toContain(`${name}:`);
    }
  });

  it('Refuses an alias that names no colour', () => {
    const ds = sample();
    const bad = { ...ds, color: { tokens: [...ds.color.tokens, { name: 'frame-mat', value: '{nope}' }] } };
    expect(() => fromDesignSystem(bad)).toThrow(SyncError);
  });

  it('Writes type styles as classes on the design system families', () => {
    expect(typographyCss(sample())).toContain('.ui-body { font-family: var(--font-sans); font-size: 15px; line-height: 22px; font-weight: 400; }');
  });

  it('The checked-in tokens.json and typography.css match design-system/tokens.json (run "pnpm tokens:sync")', () => {
    const ds = JSON.parse(read('design-system/tokens.json')) as DesignSystemTokens;
    expect(JSON.parse(read('tokens.json'))).toEqual(fromDesignSystem(ds));
    expect(read('src/generated/typography.css')).toBe(typographyCss(ds));
  });

  it('Defines every variable the design system components read', () => {
    // .dms-region is placed by --x, --y, --w and --h set on the element itself, not by tokens.
    const setOnTheElement = new Set(['--x', '--y', '--w', '--h']);
    const defined = read('src/generated/tokens.css');
    const missing = cssVariablesRead(read('design-system/components.css')).filter(
      (name) => !setOnTheElement.has(name) && !defined.includes(`${name}:`),
    );
    expect(missing).toEqual([]);
  });
});
