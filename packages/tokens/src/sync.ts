/**
 * Turns the Domesday Design System's tokens.json (the list format its page reads) into this
 * package's three-layer tokens.json, plus the type styles as CSS classes. Pure functions;
 * scripts/sync-design-system.ts does the file reading and writing.
 *
 * Names are kept exactly as the design system writes them, so the generated CSS variables
 * (--surface, --not-seen-mark, --space-4, --shadow-popover) are the ones its components.css uses.
 */

type DsValue = string | { readonly light: string; readonly dark?: string };

interface DsToken {
  readonly name: string;
  readonly value: DsValue;
}

interface DsTypeStyle {
  readonly name: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly fontWeight: number | string;
  readonly letterSpacing?: string;
  readonly opticalSize?: number;
}

export interface DesignSystemTokens {
  readonly color: { readonly tokens: readonly DsToken[] };
  readonly type: {
    readonly families: Readonly<Record<string, string>>;
    readonly groups: readonly { readonly name: string; readonly family: string; readonly styles: readonly DsTypeStyle[] }[];
  };
  readonly spacing: { readonly tokens: readonly DsToken[] };
  readonly radius: { readonly tokens: readonly DsToken[] };
  readonly stroke?: { readonly tokens: readonly DsToken[] };
  readonly size?: { readonly tokens: readonly DsToken[] };
  readonly shadow?: { readonly tokens: readonly DsToken[] };
}

type Themed = { light: string; dark: string };
type Groups = Record<string, Record<string, string | Themed>>;
export interface RepoTokens {
  $description: string;
  primitive: Groups;
  semantic: Groups;
  component: Groups;
}

export class SyncError extends Error {
  override readonly name = 'SyncError';
}

const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]*)\}$/;
const DESCRIPTION =
  'Generated from design-system/tokens.json by scripts/sync-design-system.ts. Do not edit by hand: change the Domesday Design System, export its tokens.json into design-system/, then run "pnpm tokens:sync".';

function themed(value: DsValue): Themed {
  return typeof value === 'string' ? { light: value, dark: value } : { light: value.light, dark: value.dark ?? value.light };
}

function aliasOf(value: string): string | null {
  return ALIAS.exec(value)?.[1] ?? null;
}

function stripPrefix(name: string, prefix: string): string {
  if (!name.startsWith(prefix)) throw new SyncError(`"${name}" should start with "${prefix}"`);
  return name.slice(prefix.length);
}

/** The design system's tokens in this package's format. */
export function fromDesignSystem(ds: DesignSystemTokens): RepoTokens {
  const colours = ds.color.tokens;
  const byName = new Map(colours.map((t) => [t.name, t] as const));
  // A plain value that is not an alias is a primitive, except the camera colours, which are
  // fixed on purpose but named for their job, so they sit with the semantic colours.
  const isPrimitive = (t: DsToken): boolean =>
    typeof t.value === 'string' && aliasOf(t.value) === null && !t.name.startsWith('camera-');
  const primitiveNames = new Set(colours.filter(isPrimitive).map((t) => t.name));

  const out: RepoTokens = {
    $description: DESCRIPTION,
    primitive: { color: {}, space: {}, radius: {}, stroke: {}, size: {}, font: {} },
    semantic: { color: {}, shadow: {} },
    component: {},
  };

  const refFor = (owner: string, value: string): { ref: string; toSemantic: boolean } => {
    const target = aliasOf(value);
    if (target === null) return { ref: value, toSemantic: false };
    if (!byName.has(target)) throw new SyncError(`${owner}: alias {${target}} names no colour`);
    return primitiveNames.has(target)
      ? { ref: `{primitive.color.${target}}`, toSemantic: false }
      : { ref: `{semantic.color.${target}}`, toSemantic: true };
  };

  for (const t of colours) {
    if (primitiveNames.has(t.name)) {
      (out.primitive.color as Record<string, string>)[t.name] = t.value as string;
      continue;
    }
    const v = themed(t.value);
    const light = refFor(t.name, v.light);
    const dark = refFor(t.name, v.dark);
    if (light.toSemantic || dark.toSemantic) {
      // A colour that points at another semantic colour is a component token ("button-primary").
      if (v.light !== v.dark) throw new SyncError(`${t.name}: a component colour must be the same alias in both themes`);
      const cut = t.name.indexOf('-');
      if (cut < 1) throw new SyncError(`${t.name}: component colours are named "<component>-<part>"`);
      const group = t.name.slice(0, cut);
      out.component[group] ??= {};
      (out.component[group] as Record<string, string>)[t.name.slice(cut + 1)] = light.ref;
    } else {
      (out.semantic.color as Record<string, Themed>)[t.name] = { light: light.ref, dark: dark.ref };
    }
  }

  const families: [keyof DesignSystemTokens, string, string][] = [
    ['spacing', 'space', 'space-'],
    ['radius', 'radius', 'radius-'],
    ['stroke', 'stroke', 'stroke-'],
    ['size', 'size', 'size-'],
  ];
  for (const [family, group, prefix] of families) {
    const list = (ds[family] as { tokens: readonly DsToken[] } | undefined)?.tokens ?? [];
    for (const t of list) {
      if (typeof t.value !== 'string') throw new SyncError(`${t.name}: ${family} values are plain lengths`);
      (out.primitive[group] as Record<string, string>)[stripPrefix(t.name, prefix)] = t.value;
    }
  }
  for (const [key, stack] of Object.entries(ds.type.families)) {
    (out.primitive.font as Record<string, string>)[key] = stack;
  }
  for (const t of ds.shadow?.tokens ?? []) {
    (out.semantic.shadow as Record<string, Themed>)[stripPrefix(t.name, 'shadow-')] = themed(t.value);
  }
  return out;
}

/** The design system's type styles as classes: ".ui-body { font-family: var(--font-sans); ... }". */
export function typographyCss(ds: DesignSystemTokens): string {
  const lines = ['/* Generated from design-system/tokens.json by scripts/sync-design-system.ts. Do not edit by hand. */', ''];
  for (const group of ds.type.groups) {
    if (!(group.family in ds.type.families)) throw new SyncError(`type group ${group.name}: unknown family "${group.family}"`);
    lines.push(`/* ${group.name} */`);
    for (const s of group.styles) {
      const decl = [
        `font-family: var(--font-${group.family})`,
        `font-size: ${s.fontSize}`,
        `line-height: ${s.lineHeight}`,
        `font-weight: ${s.fontWeight}`,
      ];
      if (s.letterSpacing) decl.push(`letter-spacing: ${s.letterSpacing}`);
      if (s.opticalSize !== undefined) decl.push(`font-variation-settings: 'opsz' ${s.opticalSize}`);
      lines.push(`.${s.name} { ${decl.join('; ')}; }`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Every custom property a stylesheet reads with var(--name). */
export function cssVariablesRead(css: string): string[] {
  return [...new Set([...css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((m) => m[1] as string))].sort();
}
