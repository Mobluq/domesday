# Domesday web app

The working demo of Domesday: film rooms, review the asset lines the recogniser proposes,
compare with the last walk, reconcile with the register and issue a report with a
verification code.

## Run it

```sh
pnpm install
pnpm --filter @domesday/web dev        # http://localhost:5173
```

Without a backend the app runs on an in-browser store loaded from `public/seed.json`
(the demo site: Ikeja branch, seven rooms, its register and an approved walk from
3 October 2026). Rooms with sample footage can be filmed from a laptop.

## Where it runs

`src/runtime/` hides where data and recognition come from:

- **claude.ai artifact**: shared live data (`db`), stored frames (`assets`), Claude
  (`sample`) and file saving (`downloads`) come from the artifact runtime.
  `pnpm --filter @domesday/web build:artifact` writes `dist-artifact/` to publish.
- **Local**: an in-browser store, this device only.

## Layout

- `src/pages/` the screens: Walks, Capture (phone first), Review, Comparison,
  Reconciliation, Report and Verify.
- `src/capture/` the on-device pipeline: SHA-256 fingerprint, frame picking, privacy blur,
  recognition and storing; camera checks for CCTV stills.
- `src/ai/recognise.ts` the recognition prompt and the checks every answer goes through
  (allowed categories only, readings only with the region they were read from,
  confidence only ever lowered).
- `src/data/` the document model, derived views (comparison, reconciliation) and every
  write, each recording who, when and what changed.
- `src/ui/` React versions of the Domesday Design System components.
- `scripts/` media and seed generators, the artifact build and an end-to-end run
  (`node scripts/e2e.mjs`, against `dist-artifact/`, with a stand-in recogniser).

The domain rules (comparison, reconciliation, review checks, verification codes) live in
`packages/domain` and are shared with the API.
