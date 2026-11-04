# Judgement calls

Where the PRD is specific, the code follows it. Where it is silent, the choice below was made, preferring the boring, well-supported option. Each is open to change; the ones most worth confirming with the first customers are marked **confirm**.

## Toolchain

1. **TypeScript 6.0.3, not 7.0.** TypeScript 7 (the native compiler, July 2026) is newer, but typescript-eslint supports TypeScript below 6.1 only.
2. **Shared packages export TypeScript source** (`"exports": "./src/index.ts"`) with no build step. Vite, Vitest, Metro and tsx all read it directly, so module resolution is `Bundler` everywhere. The API runs through tsx; a bundled production build is not set up yet.
3. **pnpm 10 workspaces, Node 22 LTS, Vitest 5, ESLint 10** with typescript-eslint's recommended rules.
4. **React 19.3.0 pinned for both apps**, the version Expo SDK 58 expects, so the repository has one React.
5. **React Router 7** for the web shell rather than 8 (released June 2026).
6. **Vite 8** for the web app; **Expo SDK 58 with React Native 0.88.1** for the phone app. Installing them took about 10 seconds, so they are installed and the phone app typechecks and bundles.

## Shared vocabulary (packages/domain)

7. **Codes are snake_case** and identical in TypeScript, OpenAPI enums and database CHECK constraints; labels use the PRD's exact words. Tests keep all three in step.
8. **"Lost or stolen" is two outcomes**, `lost` and `stolen` (DMS-075 writes "lost or stolen"). **confirm**
9. **Walk statuses** `capturing`, `uploading`, `processing`, `in_review`, `approved`: the PRD implies these steps but does not name them. **Line statuses** `proposed`, `accepted`, `rejected`, `merged`, `split`, where "approved" means accepted by a named person.
10. **Permissions per role** (`packages/domain/src/access/permissions.ts`). The PRD names the roles (DMS-131) but not what each may do. **confirm**
11. **The two roles that may view unblurred originals** (DMS-102) are internal auditor and tenant administrator. **confirm**
12. **MFA roles** are tenant administrator and reviewer, as DMS-130 says; partners are not required to use MFA by the PRD, so they are not here either.
13. **Objects that belong to the whole tenant** (categories, register imports, group reconciliations, the audit log) need a grant that covers every site. Site-scoped users are refused rather than shown partial data.

## Comparison rules (DMS-071 to DMS-074)

14. **Matching order:** confirmed asset identity, then tag number, then serial number, then category, appearance and position in the same room. Serials and tags are compared after trimming, upper-casing and removing spaces.
15. **Untagged items are never matched across rooms on appearance alone.** An untagged chair that moved rooms shows as not seen in one room and new in the other until a person links them, rather than the system guessing.
16. **Appearance and position thresholds** (cosine similarity 0.85; distance 0.25 of the room) are placeholders, to be calibrated on the seeded comparison set (DMS-077).
17. **One status per item.** "Moved" wins over a condition change, which is kept beside it (`conditionChange`). A counted group with fewer items is "not seen" with a negative difference; with more, "new" with a positive difference.
18. **"Room not filmed" is counted apart from changes** in the headline ("9 changes since ..."), because it is an unknown rather than a change.
19. **A move to another site** is detected only by asset identity, tag or serial, from the latest approved lines of the tenant's other sites. On the receiving site the item shows as new.
20. **Dates** are shown for Africa/Lagos in British English ("3 October"), with the year only when it differs from the current year.

## Other domain rules

21. **Clock gap (DMS-094):** device time is the phone's clock at the moment it sends the final upload request, so the gap measures clock error, not how long a clip waited for Wi-Fi. Exactly 10 minutes is not flagged ("more than 10 minutes").
22. **Capitalisation threshold (DMS-007)** compares the item's unit cost. An item exactly at the threshold is capitalised. An item with no known value is not flagged. Money is held in whole kobo.
23. **Retention (DMS-136)** counts calendar months in UTC from server time; a day that does not exist in the target month moves to the month's last day. Seven years is 84 months.
24. **WhatsApp summaries (DMS-111)** include the previous walk's date, as in the PRD's own example ("5 changes since 3 October"), alongside the counts, site name and link. The wording for the processed and approved messages is ours. Site names with money markers, addresses or phone numbers are refused, and the link must be plain https with no query string, fragment or credentials, so no token can travel in it.
25. **Bulk approval (DMS-037, DMS-052):** medium-confidence lines are refused as well as low ones, because DMS-052 allows bulk approval of high-confidence lines only. "Seen in a grid" is an explicit list of line IDs the client showed. If any requested line is not eligible, nothing is approved.
26. **Approver separation (DMS-054)** is checked per line: the person who filmed a room cannot approve that room's lines. The suggested reviewer is the first eligible one alphabetically.
27. **A skip reason** is any non-blank text.

## Phone logic (packages/capture-core)

28. **Chunks are 8 MiB** (8 × 1,024 × 1,024 bytes) for "about 8 MB"; S3 needs at least 5 MiB for every part but the last.
29. **The fingerprint travels with the final request of the upload**, the completion call, because signed part URLs cannot carry extra data. The PRD's "sends it with the final chunk" is read this way.
30. **Clip IDs are random UUIDs (v4)** from the platform (`expo-crypto` on the phone). Time-ordered UUIDs (v7) would index slightly better and can come later.
31. **SHA-256 in pure JavaScript** (`@noble/hashes`, audited) behind a swappable hasher, so a native hasher can replace it if profiling on reference devices calls for it.
32. **An unknown connection counts as metered**, so it waits like mobile data.
33. **Retries back off exponentially with full jitter**, from 2 seconds up to 5 minutes, with no attempt limit for transient failures: a clip must never be lost. A permanent failure leaves the clip on the phone as "needs attention".
34. **A clip the server rejected stays on the phone** and is never retried automatically.
35. **Pre-walk estimate (DMS-019):** 90 seconds a room (the top of the PRD's 45 to 90 seconds), 60 MB a minute (DMS-021), 25% battery an hour (DMS-154), 500 MB kept free for the phone, 10% battery kept at the end, and decimal gigabytes as phones report them. **confirm in the pilot**
36. **Ending a walk with rooms not started is allowed on the phone**, because another person may film them on the same walk (DMS-022); approval enforces room statuses on the server. A filmed room cannot be skipped.

## API (apps/api)

37. **Requests are validated against the specification itself**: the YAML is loaded and compiled with Ajv (JSON Schema 2020-12), with no hand-written schemas. JSON bodies are not type-coerced; path, query and header values are.
38. **One error format:** RFC 9457 problem details (`application/problem+json`) with a machine-readable `code` and `type: urn:domesday:problem:<code>`.
39. **Order of checks:** rate limit, then authentication, MFA and role permission before the body is read, then the Idempotency-Key check, then validation, then object checks inside the tenant's transaction. An object in another tenant is "not found" (404); an object on a site outside the caller's scope is "forbidden" (403).
40. **Idempotency keys** are scoped to the tenant and stored in the same transaction as the write, for 24 hours. The request hash covers the method, route, caller, path parameters and body. Responses of 500 or above, and the typed 501s, are not stored.
41. **Rate limits:** 600 requests a minute per client (keyed on the token, or the address without one) and 30 a minute on public routes. The counters are in memory, which is fine for one API instance; several instances need a shared store such as Redis.
42. **Signed upload URLs last 15 minutes.** The PRD sets 5 minutes for evidence links; uploads on slow networks need longer, and the phone asks for fresh URLs to resume.
43. **Uploads land in a staging area** and are copied to write-once storage only once the fingerprint checks out. A mismatched upload stays in staging, never in the originals store. If a database write fails after the copy, a write-once object can be left without a row; a periodic check should report such orphans.
44. **A clip ID already used in another tenant** is refused with a conflict and reveals nothing else.
45. **Verification codes** are 12 Crockford base32 characters in three groups, unique across all tenants. The public check takes the code and a SHA-256 the checker's browser computes from the PDF, and answers only "matches", "does not match the issued report" or "unknown code". The database makes the one report visible through a policy keyed on `app.verification_code`.
46. **The health check is liveness only** and does not touch the database.
47. **Partners** are tenants of kind `partner`; a client's grant makes the client visible to the partner. Acting for a client sets that client's tenant on the request; this belongs in the authentication adapter (ADR-DMS-05).
48. **Paths are under `/v1`.**
49. **GPU workers would fetch jobs through the API, not the database**, so the database stays owned by the monolith. Not built yet.
50. **The production object store** (S3-compatible with object lock in compliance mode) and the sign-in adapter are not built. The server refuses to start in production until they are.

## Database (db/)

51. **Composite foreign keys include tenant_id** everywhere, because foreign-key checks are not subject to row-level security.
52. **Appearance embeddings are `real[]`, not pgvector.** pgvector is not installed on the PostgreSQL 16 server available here, and PGlite does not ship it, so using it in one place only would make development and test schemas differ. The embedding model and its size are also not chosen. When Phase 0 picks them, an expand-and-contract migration can add a `vector(n)` column and an index on managed PostgreSQL. Matching runs in the API for now.
53. **Three access modes** for tables: read and write; no delete (rows that are history, such as clips, walks, register lines and investigations); append-only. Clip rows are never deleted: when retention ends, the original file is deleted and `original_deleted_at` is set.
54. **The runner keeps its bookkeeping in a `meta` schema**, so every table in `public` is a tenant table. It refuses to run if an applied migration file has changed, takes an advisory lock, and runs each migration in its own transaction. Down migrations leave the `domesday_app` role in place, because roles belong to the whole cluster.
55. **Audit events get server time from a trigger**, whatever the caller sends. `actor_user_id` has no foreign key, because partner users live in their own tenant.
56. **Asset line versions are immutable rows.** Approval is itself a new version. Proposals are keyed by a stable `proposal_key` from the assemble stage plus the model and prompt versions.
57. **A JSON null is not a source region.** Provenance checks require a JSON object, because a JSON null is not SQL NULL and a NULL result would pass a CHECK constraint (a test found this).

## Design tokens (packages/tokens)

58. **Tokens come from the Domesday Design System.** Its exported `tokens.json` and component stylesheet are kept unchanged in `packages/tokens/design-system/`, and `pnpm tokens:sync` turns them into our three-layer format (references written `{layer.group.name}`). CSS names are the design system's own (`--surface`, `--space-4`, `--button-primary`) so its components work unchanged; there is no product prefix. Generated files are checked in, with tests that fail if they drift or if a variable the components read is missing.

## GPU worker (workers/gpu)

59. **Python 3.11 or later, setuptools, pytest and mypy in strict mode.** Jobs carry no tenant identifier at all. A worker refuses a job for a model version it does not run. Fakes derive their output from a hash of the input and model version, so they are deterministic without any model.

## CI

60. **GitHub Actions** with a `postgres:16` service, so migration tests and the upload slice run against real PostgreSQL as well as PGlite. Action versions (`actions/checkout@v5`, `actions/setup-node@v5`, `actions/setup-python@v6`, `pnpm/action-setup@v4`) could not be checked from here.
