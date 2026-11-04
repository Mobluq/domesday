# Domesday web app

The working product: film rooms, review the asset lines Claude proposes, compare with the
last walk, reconcile with the fixed asset register and issue a report with a verification
code. A buyer can set up their own site in about five minutes, or try the demo site first.

## Run it

```sh
pnpm install
pnpm --filter @domesday/web dev        # http://localhost:5173
```

Without a backend the app runs on an in-browser store loaded from `public/seed.json`
(the demo site: Ikeja branch, seven rooms, its register and an approved walk from
3 October 2026). Rooms with sample footage can be filmed from a laptop.

## What's in it

- **Walks**: the next step for whoever opens it, room progress, and starting the next walk
  once one is approved (the approved walk becomes the one the next is compared against).
- **Capture**: phone first. Record in the app (with live item labels while filming, when the
  browser allows the camera), choose a clip, or use the sample footage. Label shots for
  nameplates and serials. Skipping needs a reason, and nothing in a skipped room is called
  missing.
- **Guided capture** (`#guided`): one room at a time with big buttons and nothing else on
  screen, for whoever does the walk. Made to be locked in place with Guided Access on iPhone
  or App pinning on Android. Hold to exit. Keeps the screen awake while it's open.
- **Review**: accept, edit, reject, merge and split lines, with the frame each was seen in.
  Admins can relabel, redraw a box and label an item the recogniser missed; corrections are
  fed back as lessons for this site's next recognitions (never training).
- **Comparison and Reconciliation**: what changed since the last walk, and what the books
  say. A first walk explains that it is the baseline. Not-seen rows show what the room's
  camera last saw, or a link to check it.
- **Cameras** (`#cameras`): CCTV cameras the site already has, linked to rooms. A check takes
  one still and says which recorded items are visible from that camera. Stills of spaces
  only: faces and screens blurred, no live view, and "not visible from this camera", never
  missing.
- **Report and Verify**: issue, download, print or save as PDF; anyone can check a code or a
  file against the issued report.
- **Site setup** (`#site`): rooms, people and roles, the separation rule, the capitalisation
  threshold and the register. Register import reads CSV exports from Excel, Sage or an ERP:
  columns are matched by meaning, naira and day-first dates are understood, and unknown
  locations can become rooms. A template is offered.
- **First run**: a setup wizard for a new site, and a short tour written for the role of
  whoever is using the device (reopen it from the menu under the person's name).

## Where it runs

`src/runtime/` hides where data and recognition come from:

- **Website (Vercel)**: the functions in `api/` keep shared data in Upstash Redis and call the
  Anthropic API with the server's key. See `DEPLOY.md`.
- **claude.ai artifact**: shared live data (`db`), stored frames (`assets`), Claude
  (`sample`) and file saving (`downloads`) come from the artifact runtime.
  `pnpm --filter @domesday/web build:artifact` writes `dist-artifact/` to publish.
- **Local**: an in-browser store, this device only.

## Layout

- `src/pages/` the screens: Walks, Capture, Guided capture, Review, Comparison,
  Reconciliation, Report, Verify, Cameras and Site setup.
- `src/capture/` the on-device pipeline: SHA-256 fingerprint, frame picking, privacy blur,
  recognition and storing; the in-app camera and its live labels; camera checks for CCTV
  stills.
- `src/ai/recognise.ts` the recognition prompt and the checks every answer goes through
  (allowed categories only, readings only with the region they were read from,
  confidence only ever lowered).
- `src/data/` the document model, derived views (comparison, reconciliation), register
  import, site setup and every write, each recording who, when and what changed.
- `src/ui/` React versions of the Domesday Design System components, the box editor and
  labelling dialogs, and the first-run tour.
- `scripts/` media and seed generators, the artifact build and an end-to-end run
  (`node scripts/e2e.mjs`, against `dist-artifact/`, with a stand-in recogniser).

The domain rules (comparison, reconciliation, review checks, verification codes) live in
`packages/domain` and are shared with the API.
