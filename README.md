# Domesday

Domesday turns a phone walk-through into a verified asset register, and every later walk-through into a list of what changed. A site manager films each room on a phone, AI proposes asset lines, a named person approves them, and the approved register is reconciled with the books and compared with the previous walk.

This repository is the engineering groundwork, built from the PRD (Domesday: walk-through asset register PRD) and the architecture playbook it follows: a modular monolith on one PostgreSQL database, with a separate GPU worker pool (ADR-DMS-01, ADR-DMS-02).

## What works today

| Area | State |
| --- | --- |
| Shared vocabulary and domain rules (`packages/domain`) | Built and tested: statuses, grades, roles and labels in the PRD's words; comparison between walks, walk approval, approver separation, bulk approval, clock gap, retention, capitalisation threshold, WhatsApp summaries |
| Phone logic (`packages/capture-core`) | Built and tested: walk and room states, fingerprints, immutable capture metadata, the offline upload queue, the pre-walk estimate |
| API (`apps/api`) | Specification for every area; one authorisation layer, validation, idempotency and the error format on every route; health, current user, audit log and the clip upload slice (open session, confirm, reject on fingerprint mismatch) built; every other operation returns a typed 501 |
| Database (`db`) | Ten numbered migrations with down files, a runner, and tests for tenant isolation and append-only records on PGlite and real PostgreSQL 16 |
| GPU worker (`workers/gpu`) | Job contract, idempotent job keys, the four GPU stages as typed interfaces with deterministic fakes; no models |
| Web app (`apps/web`) | Shell with the five areas, reading design tokens and domain labels; unstyled until the visual design lands |
| Phone app (`apps/capture`) | Expo skeleton with placeholder screens, using capture-core |
| Design tokens (`packages/tokens`) | Pipeline from `tokens.json` to CSS and TypeScript, with placeholder values |

## Layout

```
domesday/
├── apps/
│   ├── api/          Fastify API: openapi/domesday.yaml, src/platform, src/modules (14 modules)
│   ├── capture/      Expo phone app skeleton
│   └── web/          Vite and React web app shell
├── db/               migrations/ (numbered SQL), src/ (runner), test/ (isolation tests)
├── docs/             adr/, traceability.md, judgement-calls.md
├── packages/
│   ├── capture-core/ phone logic, testable in Node
│   ├── domain/       shared vocabulary and pure rules
│   └── tokens/       design token pipeline
└── workers/
    └── gpu/          Python GPU worker pool
```

## Module map

The API's modules follow the table in PRD Part 6. Each owns its tables, lives in `apps/api/src/modules/<module>`, and is used by others only through its `index.ts`; dependency-cruiser fails CI otherwise.

| Module | Owns | Public interface today | Operations built |
| --- | --- | --- | --- |
| tenancy-access | tenants, users, role_grants, role_grant_sites, partner_grants, partner_grant_sites | access policy, development authenticator, `getTenantSettings` | getCurrentPrincipal |
| sites | sites, site_groups, site_group_members, buildings, floors, rooms, room_imports | object resolvers | none yet |
| register | account_classes, categories, column_mappings, register_imports, register_lines | object resolvers | none yet |
| capture | walks, walk_rooms, clips, upload_sessions, label_shots | object resolvers | createClipUploadSession, confirmClipUpload |
| processing | jobs, stage_runs, frames, tracks, proposals | `enqueueAfterVerification` | none yet |
| review | asset_lines (versions), review_decisions | object resolvers | none yet |
| assets | assets | object resolvers | none yet |
| reconciliation | reconciliations, reconciliation_matches, corrections_exports | object resolvers | none yet |
| comparison | comparisons, change_items, investigations | object resolvers | none yet |
| reports | reports | object resolvers | none yet |
| evidence | audit_events, legal_holds | `appendAuditEvent` | listAuditEvents |
| notifications | walk_schedules, notification_messages | `composeWhatsAppSummary` | none yet |
| billing | tenant_plans, usage_records | none | none yet |
| ai-gateway | model_routes, model_calls, stage_switches | `chooseRoute`, `callWithGatewayPolicy` | none (internal only) |

`apps/api/src/platform` is shared by every module: loading and validating against the specification, the authorisation layer, idempotency keys, cursors, the database adapter, object storage and the error format. It may not import modules.

## Prerequisites

- Node 22.12 or later (see `.nvmrc`) and pnpm 10 (`npm install -g pnpm`, or `corepack enable`).
- Python 3.11 or later for the GPU worker.
- Optional: PostgreSQL 16 for running the database tests against a real server, and for running the API.

## Commands

From the repository root:

```sh
pnpm install          # all TypeScript workspaces
pnpm typecheck        # every package, TypeScript strict
pnpm lint             # ESLint
pnpm depcruise        # module boundaries
pnpm test:ts          # domain, capture-core, tokens, API and web tests
pnpm test:db          # migration tests (PGlite; plus PostgreSQL when TEST_DATABASE_URL is set)
pnpm test:py          # GPU worker tests (after the Python setup below)
pnpm verify           # all of the above, in the order CI runs them
```

GPU worker setup, once:

```sh
cd workers/gpu
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python -m mypy            # strict type check
.venv/bin/python -m domesday_gpu --demo   # one job through the fake privacy pass
```

### Database

```sh
DATABASE_URL=postgres://user:password@localhost:5432/domesday pnpm --filter @domesday/db migrate          # apply
DATABASE_URL=... pnpm --filter @domesday/db exec tsx src/cli.ts status    # list applied and pending
DATABASE_URL=... pnpm --filter @domesday/db migrate:down                  # revert the latest
```

The migrations create a `domesday_app` role. The API switches to it in every transaction (`SET LOCAL ROLE domesday_app`), so the role the API logs in as must be a member: `GRANT domesday_app TO <api login role>;`. Never run the API as a superuser or a role with BYPASSRLS outside development: those bypass row-level security.

### API

```sh
export DATABASE_URL=postgres://user:password@localhost:5432/domesday
export DOMESDAY_DEV_TOKENS='{"dev-token-1234":{"userId":"<uuid of a user row>","tenantId":"<uuid of its tenant>","grants":[{"role":"tenant_administrator","sites":"all"}],"mfaVerified":true}}'
pnpm --filter @domesday/api dev
curl http://127.0.0.1:3000/v1/health
curl -H 'Authorization: Bearer dev-token-1234' http://127.0.0.1:3000/v1/me
```

Development tokens stand in for the sign-in provider, which is still to be chosen (ADR-DMS-05). The server refuses to start with `NODE_ENV=production` until a real provider and object-lock storage are wired in. Video uploads go to an in-memory store in development.

### Web and phone apps

```sh
pnpm --filter @domesday/web dev          # http://localhost:5173, proxies /v1 to the API
pnpm --filter @domesday/web build
pnpm --filter @domesday/capture start    # Expo
```

### Design tokens

Edit `packages/tokens/tokens.json`, run `pnpm tokens`, and commit the generated files. The format is described in `packages/tokens/README.md`.

## Testing against a real PostgreSQL

Set `TEST_DATABASE_URL` to a server where the user can create databases and roles. Each run creates a fresh database and drops it afterwards. CI does this with a `postgres:16` service.

```sh
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres pnpm test:db
TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres pnpm test:ts
```

A throwaway local cluster works too. PostgreSQL will not run as root, so start it as an ordinary user, with its data and socket in a folder git ignores:

```sh
mkdir -p .tmp && initdb -D .tmp/pg16 -U postgres --auth=trust
pg_ctl -D .tmp/pg16 -o "-p 54329 -k $PWD/.tmp -c listen_addresses=''" -l .tmp/pg16.log start
export TEST_DATABASE_URL="postgresql://postgres@localhost:54329/postgres?host=$PWD/.tmp"
```

## What PGlite proves, and what still needs a real PostgreSQL

The database tests run on PGlite, which is PostgreSQL (version 18.6 at the time of writing) compiled to WebAssembly. It supports roles, `SET ROLE`, forced row-level security, policies, privileges, triggers and generated columns, so the tenant isolation and append-only tests are real there, not simulated. The same suite also passed against a real PostgreSQL 16.15 server while this was built, and CI runs it against PostgreSQL 16.

Not covered by any test yet:

- **Concurrency.** PGlite has one connection and the tests run one request at a time, so two requests racing on the same Idempotency-Key, or two migration runners contending for the advisory lock, are untested.
- **Connection pooling.** The tenant setting and role are transaction-local (`SET LOCAL`, `set_config(..., true)`), which suits PgBouncer in transaction mode, but this has not been run behind a pooler.
- **pgvector**, which is not installed here (embeddings are `real[]`; see docs/judgement-calls.md).
- **Object lock on real storage**, backups and a tested restore (Part 6 asks for both before launch), and anything about performance or load.

## Documentation

- `apps/api/openapi/domesday.yaml`: the API contract, written first.
- `docs/adr/`: the nine architecture decisions and their status from the PRD.

  | ADR | Decision | Status |
  | --- | --- | --- |
  | [ADR-DMS-01](docs/adr/ADR-DMS-01-modular-monolith-on-postgres.md) | Modular monolith on one PostgreSQL database, with row-level security on tenant_id | Proposed |
  | [ADR-DMS-02](docs/adr/ADR-DMS-02-gpu-worker-pool.md) | GPU workers as a separate Python process pool | Proposed |
  | [ADR-DMS-03](docs/adr/ADR-DMS-03-stage-6-hosted-model.md) | Stage 6 on a hosted multimodal model through the gateway, self-hosted fallback evaluated | Open: decide at the benchmark gate |
  | [ADR-DMS-04](docs/adr/ADR-DMS-04-restricted-originals-vault.md) | Unblurred originals in a restricted write-once vault | Open: decide at the benchmark gate, with counsel |
  | [ADR-DMS-05](docs/adr/ADR-DMS-05-buy-authentication.md) | Buy authentication (Auth0, Clerk or WorkOS) | Open |
  | [ADR-DMS-06](docs/adr/ADR-DMS-06-hosting-region.md) | Hosting region and cross-border transfer basis | Open: needs counsel |
  | [ADR-DMS-07](docs/adr/ADR-DMS-07-product-name.md) | Product name | Open: test with buyers |
  | [ADR-DMS-08](docs/adr/ADR-DMS-08-training-opt-in.md) | Training on customer data is opt-in only, in writing | Proposed |
  | [ADR-DMS-09](docs/adr/ADR-DMS-09-price-per-site.md) | Price per site per month with walks included | Proposed: test in pilot |

- `docs/traceability.md`: each implemented rule, its DMS ID, where it lives and which test proves it.
- `docs/judgement-calls.md`: every choice made where the PRD was silent.
- `packages/tokens/README.md`: the design token format.
