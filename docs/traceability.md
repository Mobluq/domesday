# Traceability

Each requirement this groundwork implements, where it is enforced, and the test that proves it. Requirements that exist only as an API operation, with no behaviour built yet, are listed at the end.

Paths are from the repository root. "Domain" means `packages/domain/src`, "capture-core" means `packages/capture-core/src`, "API" means `apps/api/src`, and "GPU" means `workers/gpu/src/domesday_gpu`.

## Enforced and tested

| DMS ID | Rule | Where | Tests |
| --- | --- | --- | --- |
| DMS-002 | A room named on the phone is saved as provisional | capture-core `walk.ts` (`add_provisional_room`); `db/migrations/0002_sites.sql` (`rooms.provisional`) | `packages/capture-core/test/capture.test.ts` |
| DMS-004 | Every source field of an imported line is kept unchanged | `db/migrations/0004_register.sql` (trigger `keep_source_fields`) | `db/test/migrations.test.ts` |
| DMS-007 | Items below the capitalisation threshold are counted but flagged "Below threshold" | Domain `rules/register.ts` (`capitalisationFlag`); `tenants.capitalisation_threshold_kobo` | `packages/domain/test/rules.test.ts` |
| DMS-010 | Rooms are not started, filmed or skipped; a skipped room needs a reason | Domain `vocabulary/statuses.ts`, `rules/review.ts` (`isValidSkipReason`); capture-core `walk.ts`; `walk_rooms` constraint `skipped_room_needs_reason`; API spec `SetWalkRoomStatusRequest` | `capture.test.ts`, `migrations.test.ts`, `apps/api/test/authorisation.test.ts` |
| DMS-011, DMS-153 | Capture works fully offline; every clip uploads when the phone reconnects | capture-core `upload/queue.ts` | `packages/capture-core/test/upload-queue.test.ts` |
| DMS-012 | Chunks of about 8 MB; resume from the last confirmed chunk; Wi-Fi by default, mobile data by opt-in | capture-core `upload/policy.ts`, `upload/queue.ts` | `upload-queue.test.ts` |
| DMS-015 | Label shots are linked to their moment in the clip, and every one is kept | `label_shots.offset_ms`; GPU `stages/frames.py` | `workers/gpu/tests/test_stages.py` |
| DMS-017 | Capture metadata (user, device, start, end, location where allowed) cannot change once a clip is closed | capture-core `clip.ts` (frozen clips); trigger `guard_capture_record` on `clips`; API takes the filmer from the signed-in user | `capture.test.ts`, `migrations.test.ts`, `apps/api/test/confirm-upload.test.ts` |
| DMS-018 | SHA-256 computed when recording stops; the server recomputes it and rejects and logs a mismatch | capture-core `fingerprint.ts`, `clip.ts` (`stopClip`), `upload/queue.ts` (fingerprint on the final request); API `modules/capture/confirm-upload.ts`; constraints `verified_needs_matching_fingerprint`, `rejected_means_mismatch` | `capture.test.ts`, `upload-queue.test.ts`, `confirm-upload.test.ts`, `migrations.test.ts` |
| DMS-019 | Warn below 2 GB free and estimate how many rooms will fit | capture-core `pre-walk.ts` | `capture.test.ts` |
| DMS-022 | Each clip is credited to its filmer | `clips.captured_by`; API `upload-session.ts` | `confirm-upload.test.ts` |
| DMS-023 | The local copy is deleted only after the server confirms the clip | capture-core `upload/queue.ts` | `upload-queue.test.ts` |
| DMS-031 | One item followed across frames is one track | GPU `stages/detect_track.py` | `test_stages.py` |
| DMS-033, Part 5 | Serial, model and tag values only from text actually read, with the image region | Domain `rules/register.ts` (`checkReadProvenance`); constraints `serial_needs_source_region` and friends on `proposals` and `asset_lines`; API spec `LineChanges` (`dependentRequired`); GPU `stages/ocr.py` (`TextRead`) | `rules.test.ts`, `migrations.test.ts`, `test_stages.py` |
| DMS-036 | Condition on a 4-point scale | Domain `vocabulary/statuses.ts` (`ConditionGrade`, `conditionSeverity`) | `packages/domain/test/vocabulary.test.ts` |
| DMS-037, DMS-052 | Low-confidence lines cannot be bulk approved; only high-confidence lines seen in the grid can | Domain `rules/review.ts` (`checkBulkApproval`) | `rules.test.ts` |
| DMS-042 | Reprocessing with the same model version never duplicates; jobs keyed by clip, stage and model version | Constraints `job_key`, `proposal_key`, index `stage_runs_one_success`; API `modules/processing/index.ts`; GPU `contract.py` (`JobKey`), `worker.py`, `fakes.py`; domain `compareWalks` is deterministic | `migrations.test.ts`, `confirm-upload.test.ts`, `test_worker.py`, `compare-walks.test.ts` |
| DMS-050 | Review queue ordered low, medium, high | Domain `REVIEW_ORDER`, `orderReviewQueue` | `rules.test.ts` |
| DMS-053, DMS-093 | Every decision records who, when and what; an edit to an approved line needs a reason and writes a new version | `asset_lines` (one immutable row per version, trigger `versioning`); `review_decisions` (append-only); domain `checkEditAfterApproval` | `migrations.test.ts`, `rules.test.ts` |
| DMS-054 | The capturer cannot be the sole approver unless the tenant switches the rule off; the refusal names another reviewer | Domain `rules/review.ts` (`checkApproverSeparation`); `tenants.capturer_separation_rule` | `rules.test.ts` |
| DMS-058 | A walk is approved only when every line has a decision and every room is filmed or has a skip reason | Domain `rules/review.ts` (`checkWalkApproval`) | `rules.test.ts` |
| DMS-060, DMS-061 | Found, found elsewhere (with both sites), unrecorded, not seen; description matches show a score and need a person | Domain `ReconStatus`; constraints on `reconciliation_matches` (`description_match_needs_confirmation`) | `vocabulary.test.ts`, `migrations.test.ts` |
| DMS-063, Part 5 | "Not seen on this walk" until an outcome is recorded; nothing is called missing, lost or stolen before then | Domain `ChangeStatus`, `ReconStatus` labels, `notSeenLabel` | `vocabulary.test.ts`, `rules.test.ts` |
| DMS-071 | Change statuses, and "room not filmed", never "not seen", when the room was not filmed | Domain `rules/compare-walks.ts` (`compareWalks`, `classifyMatchedPair`); constraints on `change_items` | `compare-walks.test.ts`, `migrations.test.ts` |
| DMS-072 | Untagged assets matched by serial, then category, appearance and position in the room | Domain `matchLinesAcrossWalks` | `compare-walks.test.ts` |
| DMS-073 | Counted groups compare quantities ("24 chairs, was 32", minus 8) | Domain `classifyMatchedPair`, `describeGroupQuantity`, `describeQuantityDelta`; `change_items.quantity_delta` constraint | `compare-walks.test.ts` |
| DMS-074 | Changes first, unchanged as one count; "9 changes since the walk on 3 October" | Domain `compareWalks`, `comparisonHeadline` | `compare-walks.test.ts` |
| DMS-075 | Investigation outcomes; "transferred" needs the new site | Domain `InvestigationOutcome`; constraints on `investigations` | `vocabulary.test.ts`, `migrations.test.ts` |
| DMS-086 | A verification code confirms a report without showing it | Policy `public_verification_by_code` on `reports`; code format constraint; trigger `guard_issued`; API spec `verifyReport` | `migrations.test.ts` |
| DMS-090 | Originals are write-once for the retention period | API `platform/object-store.ts` (object lock in the store used for development and tests); trigger on `clips` (retention never shortened, rows never deleted) | `confirm-upload.test.ts`, `migrations.test.ts` |
| DMS-091 | Derived records point back to the clip, time code and fingerprint | `frames.clip_sha256`, `frames.time_code_ms`; API spec `FrameRef` | Schema only |
| DMS-092 | Append-only audit log: no role has UPDATE or DELETE; even the owner is refused | `db/migrations/0009_reports_evidence.sql` (`audit_events`, append-only mode, server time); API `modules/evidence` (`appendAuditEvent`, `listAuditEvents`) | `migrations.test.ts`, `confirm-upload.test.ts` |
| DMS-094 | Server time is the record of truth; a gap of more than 10 minutes is flagged | Domain `rules/evidence.ts` (`assessClockGap`); generated column `clips.clock_gap_flag`; API `confirm-upload.ts` | `rules.test.ts`, `migrations.test.ts` (database and domain agree at the boundaries), `confirm-upload.test.ts` |
| DMS-096 | A legal hold overrides deletion; lifting needs two different administrators | Domain `isDueForDeletion`; constraint `lifted_by_two_administrators` | `rules.test.ts`, `migrations.test.ts` |
| DMS-100, DMS-101, DMS-104 | Faces, screens and documents blurred; audio removed from derivatives | GPU `stages/privacy.py` (interface and fake) | `test_stages.py` |
| DMS-102 | Unblurred originals viewable by exactly two named roles | Domain `access/permissions.ts` (`UNBLURRED_VIEWER_ROLES`, `evidence:read_unblurred`) | `packages/domain/test/access-and-whatsapp.test.ts` |
| DMS-103 | "Recording spaces for asset count" with a red indicator | Domain `UI_COPY.recordingNotice`; `apps/capture/src/screens/FilmingScreen.tsx` | `vocabulary.test.ts` |
| DMS-110, DMS-111 | WhatsApp summaries carry counts, the site name and a link only | Domain `rules/whatsapp-summary.ts`; API `modules/notifications` | `access-and-whatsapp.test.ts` |
| DMS-120, DMS-121 | A partner sees exactly the client tenants with a live grant | Policies `partner_reads_grants_made_to_it`, `partner_reads_granting_tenants` | `migrations.test.ts` |
| DMS-130 | Administrators and reviewers without MFA are stopped before any data | Domain `requiresMfa`; API `platform/authz.ts` | `access-and-whatsapp.test.ts`, `authorisation.test.ts` |
| DMS-131, DMS-132 | Roles scoped by site; a site manager cannot open another site's walks | Domain `canAccessSite`, `sitesInScope`; API `platform/authz.ts` (`authoriseObjects`) | `access-and-whatsapp.test.ts`, `authorisation.test.ts`, `confirm-upload.test.ts` |
| DMS-136 | Originals kept 13 months to 7 years | Domain `checkRetentionMonths`, `retentionUntil`; constraint on `tenants.originals_retention_months` | `rules.test.ts`, `migrations.test.ts` (database and domain agree) |
| DMS-157 | Every list paginated by cursor; every route rate limited per client | `apps/api/openapi/domesday.yaml`; API `platform/pagination.ts`, `app.ts` (rate limit) | `apps/api/test/spec.test.ts`, `authorisation.test.ts`, `confirm-upload.test.ts` |

## Cross-cutting rules from Parts 5 and 6

| Rule | Where | Tests |
| --- | --- | --- |
| One shared authorisation layer on every route (Part 6, Security) | API `platform/authz.ts`, `platform/register.ts` | `authorisation.test.ts` (every protected operation refuses anonymous callers, every operation outside a role's permissions refuses it) |
| Modules use each other only through their public interface (Part 6) | `.dependency-cruiser.cjs` | `apps/api/test/boundaries.test.ts` |
| Every table carries tenant_id with row-level security (Part 6, ADR-DMS-01) | `db/migrations/0001_foundation.sql` and every later migration | `migrations.test.ts` |
| Every write takes an Idempotency-Key (Part 6, API design) | API `platform/idempotency.ts`; `idempotency_keys` table | `spec.test.ts`, `confirm-upload.test.ts` |
| One error format with machine-readable codes (Part 6, API design) | API `platform/errors.ts`, `platform/register.ts` | `spec.test.ts`, `authorisation.test.ts` |
| Only zero-data-retention providers through the gateway (Part 5) | API `modules/ai-gateway`; constraint `zero_data_retention_only` | `boundaries.test.ts`, `migrations.test.ts` |
| One retry with jitter for hosted-model calls (Part 6) | API `modules/ai-gateway` (`callWithGatewayPolicy`) | `boundaries.test.ts` |
| Each AI stage can be switched off (Part 5) | `stage_switches`; GPU `registry.py` | `test_worker.py` |
| Every launch migration is reversible (Part 6) | `db/migrations/*.down.sql`, `db/src/migrate.ts` | `migrations.test.ts` |
| The shared vocabulary is the same in the domain, the API and the database | `packages/domain`; spec enums; database CHECK constraints | `spec.test.ts`, `migrations.test.ts` |

## Specified in the API, not built yet

Every other operation in `apps/api/openapi/domesday.yaml` passes through the authorisation layer and validation, then returns a typed `501 not_implemented`. These cover, among others: room and register imports (DMS-001, DMS-003), categories (DMS-005, DMS-006), the review decisions and walk approval endpoints (DMS-051 to DMS-058; the rules exist in the domain package), reconciliation and the corrections export (DMS-060 to DMS-065), comparisons and investigations (DMS-070 to DMS-075; the rules exist in the domain package), reports and verification (DMS-080 to DMS-088), evidence access and legal holds (DMS-091, DMS-096, DMS-102), walk schedules (DMS-112) and billing (DMS-133, DMS-134).
