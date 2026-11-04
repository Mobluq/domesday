import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TokenError, buildTokens, parseTokens } from '../src/build';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const minimal = () => ({
  primitive: { color: { white: '#ffffff', black: '#000000' }, space: { '4': '16px' } },
  semantic: {
    color: { surface: { light: '{primitive.color.white}', dark: '{primitive.color.black}' } },
    space: { inset: '{primitive.space.4}' },
  },
  component: { card: { background: '{semantic.color.surface}', padding: '{semantic.space.inset}' } },
});

describe('token pipeline', () => {
  it('Emits light values on :root and dark values under prefers-color-scheme and [data-theme="dark"]', () => {
    const { css } = buildTokens(minimal());
    expect(css).toContain(':root {\n  color-scheme: light;');
    expect(css).toContain('--white: #ffffff;');
    expect(css).toContain('--surface: var(--white);');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\) \{[^}]*--surface: var\(--black\);/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--surface: var\(--black\);/);
  });

  it('Keeps component tokens as references, so they follow the theme', () => {
    const { css } = buildTokens(minimal());
    expect(css).toContain('--card-background: var(--surface);');
    expect(css).toContain('--card-padding: var(--space-inset);');
  });

  it('Emits a TypeScript module with CSS references and resolved values per theme', () => {
    const { ts } = buildTokens(minimal());
    expect(ts).toContain('"card-background": "var(--card-background)"');
    expect(ts).toMatch(/light: \{[\s\S]*"card-background": "#ffffff"/);
    expect(ts).toMatch(/dark: \{[\s\S]*"card-background": "#000000"/);
  });

  it('Refuses a semantic colour without a dark value', () => {
    const input = minimal();
    (input.semantic.color as Record<string, unknown>).surface = { light: '#fff' };
    expect(() => parseTokens(input)).toThrow(/need both a "light" and a "dark" value/);
  });

  it('Refuses unknown references, references that skip a layer the wrong way, and cycles', () => {
    const unknown = minimal();
    unknown.component.card.background = '{semantic.color.nope}';
    expect(() => buildTokens(unknown)).toThrow(/unknown reference/);

    const upward = minimal();
    (upward.semantic.space as Record<string, string>).inset = '{component.card.padding}';
    expect(() => buildTokens(upward)).toThrow(/may not reference a component token/);

    const primitiveRef = minimal();
    primitiveRef.primitive.color.white = '{primitive.color.black}';
    expect(() => buildTokens(primitiveRef)).toThrow(/primitives hold raw values/);
  });

  it('Refuses two tokens that would share a CSS name, and odd names', () => {
    const clash = minimal() as Record<string, Record<string, Record<string, unknown>>>;
    (clash.semantic as Record<string, Record<string, unknown>>).color = {
      ...(clash.semantic?.color ?? {}),
      white: { light: '#fff', dark: '#000' },
    };
    expect(() => parseTokens(clash)).toThrow(TokenError);
    expect(() => parseTokens({ ...minimal(), primitive: { Color: { a: '#fff' } } })).toThrow(/lower-case/);
  });

  it('Names colours without their group, as the design system does, and themes semantic shadows', () => {
    const input = minimal() as ReturnType<typeof minimal> & { semantic: Record<string, unknown> };
    input.semantic.shadow = { popover: { light: '0 1px 2px rgba(0,0,0,0.1)', dark: '0 1px 2px rgba(0,0,0,0.5)' } };
    const { css, ts } = buildTokens(input);
    expect(css).toContain('--surface: var(--white);');
    expect(css).not.toContain('--color-surface');
    expect(css).toContain('--space-inset: var(--space-4);');
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--shadow-popover: 0 1px 2px rgba\(0,0,0,0.5\);/);
    expect(ts).toContain('"surface": "var(--surface)"');
  });

  it('Refuses a semantic shadow without a dark value, and themed values anywhere else', () => {
    const input = minimal() as ReturnType<typeof minimal> & { semantic: Record<string, unknown> };
    input.semantic.shadow = { popover: { light: '0 1px 2px #000' } };
    expect(() => parseTokens(input)).toThrow(/semantic shadows need both/);
    const elsewhere = minimal() as Record<string, Record<string, Record<string, unknown>>>;
    (elsewhere.component as Record<string, Record<string, unknown>>).card = { background: { light: '#fff', dark: '#000' } };
    expect(() => parseTokens(elsewhere)).toThrow(/only semantic colours and shadows/);
  });

  it('The checked-in generated files match tokens.json (run "pnpm tokens" after editing it)', () => {
    const output = buildTokens(JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8')));
    expect(readFileSync(join(root, 'src/generated/tokens.css'), 'utf8')).toBe(output.css);
    expect(readFileSync(join(root, 'src/generated/tokens.ts'), 'utf8')).toBe(output.ts);
  });
});
