/**
 * Design token pipeline: tokens.json (primitive, semantic, component) to CSS
 * custom properties and a TypeScript module. Pure functions; scripts/build.ts
 * does the file reading and writing. The format is described in README.md.
 */

export const LAYERS = ['primitive', 'semantic', 'component'] as const;
export type Layer = (typeof LAYERS)[number];
export type Theme = 'light' | 'dark';

/** A value is raw text ("#fff", "4px") or a reference to another token ("{primitive.color.neutral-0}"). */
export type TokenValue = string;
export type ThemedValue = { readonly light: TokenValue; readonly dark: TokenValue };

export interface Token {
  readonly layer: Layer;
  /** "color", "button" and so on. */
  readonly group: string;
  readonly name: string;
  /** Dotted path used in references: "semantic.color.surface". */
  readonly path: string;
  /** CSS custom property: "--surface" for colours, "--space-4" for everything else. */
  readonly cssName: string;
  /** Key in the generated TypeScript maps: "surface", "space-4". */
  readonly key: string;
  readonly value: TokenValue | ThemedValue;
}

export class TokenError extends Error {
  override readonly name = 'TokenError';
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REFERENCE = /^\{([a-z]+)\.([a-z0-9-]+)\.([a-z0-9-]+)\}$/;
// Names match the Domesday Design System exactly (--surface, --not-seen-mark, --space-4), so its
// components.css works unchanged. Colours drop their group name; every other group keeps it.
const CSS_PREFIX = '--';
/** Semantic groups that take a light and a dark value. */
const THEMED_GROUPS: readonly string[] = ['color', 'shadow'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkRawValue(path: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TokenError(`${path}: value must be non-empty text`);
  if (/[;{}]/.test(value) && !REFERENCE.test(value)) throw new TokenError(`${path}: value must not contain ";", "{" or "}"`);
  return value;
}

/** Read and validate a parsed tokens.json. Throws TokenError with the token's path on any problem. */
export function parseTokens(input: unknown): Token[] {
  if (!isRecord(input)) throw new TokenError('tokens.json must be an object');
  for (const key of Object.keys(input)) {
    if (!(LAYERS as readonly string[]).includes(key) && key !== '$schema' && key !== '$description') {
      throw new TokenError(`unknown top-level key "${key}"; expected primitive, semantic and component`);
    }
  }
  const tokens: Token[] = [];
  for (const layer of LAYERS) {
    const groups = input[layer];
    if (!isRecord(groups)) throw new TokenError(`"${layer}" must be an object of groups`);
    for (const [group, entries] of Object.entries(groups)) {
      if (!NAME.test(group)) throw new TokenError(`${layer}.${group}: group names are lower-case words joined by "-"`);
      if (!isRecord(entries)) throw new TokenError(`${layer}.${group} must be an object of tokens`);
      for (const [name, raw] of Object.entries(entries)) {
        const path = `${layer}.${group}.${name}`;
        if (!NAME.test(name)) throw new TokenError(`${path}: token names are lower-case words joined by "-"`);
        let value: TokenValue | ThemedValue;
        if (layer === 'semantic' && THEMED_GROUPS.includes(group)) {
          if (!isRecord(raw) || !('light' in raw) || !('dark' in raw)) {
            const what = group === 'color' ? 'colours' : 'shadows';
            throw new TokenError(`${path}: semantic ${what} need both a "light" and a "dark" value`);
          }
          const extra = Object.keys(raw).filter((k) => k !== 'light' && k !== 'dark');
          if (extra.length > 0) throw new TokenError(`${path}: unexpected keys ${extra.join(', ')}`);
          value = { light: checkRawValue(`${path}.light`, raw.light), dark: checkRawValue(`${path}.dark`, raw.dark) };
        } else {
          if (isRecord(raw)) throw new TokenError(`${path}: only semantic colours and shadows take light and dark values`);
          value = checkRawValue(path, raw);
        }
        if (layer === 'primitive' && REFERENCE.test(value as string)) {
          throw new TokenError(`${path}: primitives hold raw values, not references`);
        }
        const key = group === 'color' ? name : `${group}-${name}`;
        tokens.push({ layer, group, name, path, key, cssName: `${CSS_PREFIX}${key}`, value });
      }
    }
  }
  const seen = new Map<string, string>();
  for (const t of tokens) {
    const clash = seen.get(t.cssName);
    if (clash) throw new TokenError(`${t.path} and ${clash} would both become ${t.cssName}`);
    seen.set(t.cssName, t.path);
  }
  return tokens;
}

const ALLOWED_REFERENCES: Readonly<Record<Layer, readonly Layer[]>> = {
  primitive: [],
  semantic: ['primitive'],
  component: ['semantic', 'primitive'],
};

function referenceTarget(token: Token, value: TokenValue, byPath: ReadonlyMap<string, Token>): Token | null {
  const match = REFERENCE.exec(value);
  if (!match) return null;
  const [, layer, group, name] = match;
  const path = `${layer}.${group}.${name}`;
  const target = byPath.get(path);
  if (!target) throw new TokenError(`${token.path}: unknown reference {${path}}`);
  if (!ALLOWED_REFERENCES[token.layer].includes(target.layer)) {
    throw new TokenError(`${token.path}: a ${token.layer} token may not reference a ${target.layer} token`);
  }
  return target;
}

function valueFor(token: Token, theme: Theme): TokenValue {
  return typeof token.value === 'string' ? token.value : token.value[theme];
}

/** The final raw value of a token for a theme, following references. */
export function resolveToken(token: Token, theme: Theme, byPath: ReadonlyMap<string, Token>, trail: string[] = []): string {
  if (trail.includes(token.path)) throw new TokenError(`circular reference: ${[...trail, token.path].join(' -> ')}`);
  const value = valueFor(token, theme);
  const target = referenceTarget(token, value, byPath);
  return target ? resolveToken(target, theme, byPath, [...trail, token.path]) : value;
}

/** CSS for a token's value: a reference becomes var(--...), so dark mode flows through to components. */
function cssValue(token: Token, theme: Theme, byPath: ReadonlyMap<string, Token>): string {
  const value = valueFor(token, theme);
  const target = referenceTarget(token, value, byPath);
  return target ? `var(${target.cssName})` : value;
}

export interface BuildOutput {
  readonly css: string;
  readonly ts: string;
}

const HEADER = 'Generated from tokens.json by packages/tokens/scripts/build.ts. Do not edit by hand.';

export function buildTokens(input: unknown): BuildOutput {
  const tokens = parseTokens(input);
  const byPath = new Map(tokens.map((t) => [t.path, t] as const));
  for (const t of tokens) {
    resolveToken(t, 'light', byPath);
    resolveToken(t, 'dark', byPath);
  }
  const themed = tokens.filter((t) => typeof t.value !== 'string');
  const line = (t: Token, theme: Theme): string => `  ${t.cssName}: ${cssValue(t, theme, byPath)};`;
  const darkBlock = themed.map((t) => `  ${line(t, 'dark')}`).join('\n');

  const css = [
    `/* ${HEADER} */`,
    '',
    ':root {',
    '  color-scheme: light;',
    ...LAYERS.flatMap((layer) => {
      const inLayer = tokens.filter((t) => t.layer === layer);
      return inLayer.length === 0 ? [] : [`  /* ${layer} */`, ...inLayer.map((t) => line(t, 'light'))];
    }),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    '    color-scheme: dark;',
    darkBlock,
    '  }',
    '}',
    '',
    ':root[data-theme="dark"] {',
    '  color-scheme: dark;',
    themed.map((t) => line(t, 'dark')).join('\n'),
    '}',
    '',
  ].join('\n');

  const entries = (map: (t: Token) => string): string => tokens.map((t) => `  ${JSON.stringify(t.key)}: ${map(t)},`).join('\n');
  const ts = [
    `// ${HEADER}`,
    '',
    '/** CSS custom property references, for styles that run in a browser. */',
    'export const cssVar = {',
    entries((t) => JSON.stringify(`var(${t.cssName})`)),
    '} as const;',
    '',
    'export type TokenName = keyof typeof cssVar;',
    '',
    '/** Fully resolved values per theme, for platforms without CSS variables such as the phone app. */',
    'export const resolved = {',
    '  light: {',
    tokens.map((t) => `    ${JSON.stringify(t.key)}: ${JSON.stringify(resolveToken(t, 'light', byPath))},`).join('\n'),
    '  },',
    '  dark: {',
    tokens.map((t) => `    ${JSON.stringify(t.key)}: ${JSON.stringify(resolveToken(t, 'dark', byPath))},`).join('\n'),
    '  },',
    '} as const satisfies Record<"light" | "dark", Record<TokenName, string>>;',
    '',
  ].join('\n');

  return { css, ts };
}
