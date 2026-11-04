# ADR-DMS-02: GPU workers run as a separate Python process pool

Status: Proposed

## Context

Blurring, frame selection, detection, tracking and OCR need GPUs and Python machine learning libraries. That is a very different runtime and scaling profile from the API, which the PRD names as the reason for running them apart (Part 6). The playbook allows a separate service only for a named reason like this one.

## Decision

- The GPU worker pool is a Python package, `workers/gpu`, covering pipeline stages 2 to 5: privacy pass, pick frames, detect and track, and read text and tags (Part 5).
- Workers hold no business data of their own. A worker pulls a job, reads a clip, writes results and exits. A job carries identifiers, storage locations and the pinned model version only; it has no tenant name, site, register value or person in it.
- Every job is keyed by clip, stage and model version, so a repeat is harmless (DMS-042). The database enforces the key (`jobs.job_key`), the worker acknowledges a job whose result already exists without redoing it, and a different result for the same key is treated as a determinism bug.
- A worker refuses a job for a model version it does not run, and a stage switched off for a tenant refuses work (the Part 5 kill switch).
- The processing module in the API owns the queue: capped retries with jittered backoff, then a dead-letter queue, with alerts on the age of the oldest job (Part 6).

## Consequences

- The GPU fleet scales on its own, and machine learning dependencies stay out of the API.
- Two languages to maintain. The job contract is written down twice (`workers/gpu/src/domesday_gpu/contract.py` and the processing module), so changes must keep both in step.
- How workers fetch jobs and return results is not built yet. The proposal is that they talk to the API rather than the database, so the database stays owned by the monolith (see docs/judgement-calls.md).

## In this repository

`workers/gpu` (contract, stage interfaces with fakes, run-once worker, tests), `db/migrations/0006_processing.sql`, `apps/api/src/modules/processing/index.ts`.
