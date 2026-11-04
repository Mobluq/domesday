# Design tokens

Every design value the web app and phone app use comes from the **Domesday Design System** (the design system artifact on claude.ai, with its brand book, components and assets). This package keeps a copy of its export and turns it into code.

```
design-system/tokens.json      exported from the design system, unchanged
design-system/components.css   the design system's component stylesheet, unchanged
        │  pnpm tokens:sync
        ▼
tokens.json                    the same values in this package's three-layer format
src/generated/typography.css   the type styles as classes (.ui-body, .display-l, .data-m ...)
        │  pnpm tokens (run by tokens:sync)
        ▼
src/generated/tokens.css       CSS custom properties, light and dark
src/generated/tokens.ts        typed var() references and resolved values per theme
```

Never edit `tokens.json` or anything under `src/generated/` by hand. To change a colour, a size or a type style, change it in the design system, export its `tokens.json` (and `components/bundle.css` if components changed, saved here as `components.css`) into `design-system/`, then run `pnpm tokens:sync` from the repo root and commit the result. Tests fail if any of these files drift apart.

## Names

CSS names are the design system's own, so its `components.css` works unchanged:

- colours have no group in their name: `--surface`, `--text-secondary`, `--not-seen-mark`, `--camera-record`
- everything else keeps its group: `--space-4`, `--radius-s`, `--stroke-tick`, `--size-touch-capture`, `--font-mono`, `--shadow-popover`
- component colours are `--<component>-<part>`: `--button-primary`, `--frame-mat`, `--approval-stroke`

A test checks that every variable `components.css` reads is defined in `tokens.css`.

## Using it

Web (see `apps/web`):

```ts
import '@domesday/tokens/tokens.css';
import '@domesday/tokens/typography.css';
import '@domesday/tokens/components.css';
```

Load the three font families from Google Fonts (the link is in `apps/web/index.html` and in the design system's README) and put `class="dms"` on the app root for base type, tabular figures and focus rings. Then use the component classes the design system documents: `dms-btn`, `dms-chip`, `dms-frame`, `dms-region`, `dms-lineno`, `dms-change` and the rest.

Phone (see `apps/capture/src/theme.ts`): React Native has no CSS variables, so it reads `resolved.light` and `resolved.dark` from `@domesday/tokens`, keyed by the same names (`colours['surface']`, `colours['camera-record']`).

## The three-layer format

| Layer | Holds | May reference |
| --- | --- | --- |
| `primitive` | Raw values: the paper, ink and rubric colours, spacing, radii, strokes, sizes, font stacks | Nothing |
| `semantic` | What a value is for: surfaces, text, status colours, camera colours, shadows | Primitives |
| `component` | Values for one component: a button's fill, an evidence frame's mat | Semantic tokens or primitives |

Rules the build enforces:

- Every semantic colour and semantic shadow has a `light` and a `dark` value. Nothing else takes two values.
- A reference is written `{layer.group.name}` and must point at a token that exists, in a layer the table allows.
- Group and token names are lower-case words joined by `-`.
- Two tokens may not produce the same CSS name.

`pnpm --filter @domesday/tokens check` fails if the generated CSS and TypeScript are out of date.
