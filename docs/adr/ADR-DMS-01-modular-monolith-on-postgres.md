# ADR-DMS-01: Modular monolith on one PostgreSQL database, with row-level security on tenant_id

Status: Proposed

## Context

Domesday is at the pre-launch stage (PRD Part 6). The architecture playbook's default for that stage is one modular monolith on one relational database, adding complexity only when a measured limit demands it. Customers are organisations with 5 to 500 sites, and audit firms and brokers will work across several client tenants (DMS-120), so one tenant must never see another's evidence. The PRD requires isolation in the database, not only in application code.

## Decision

- One codebase, three process types: the API, the job workers and the scheduler run from the same code and scale separately (PRD Part 6). This repository has the API so far (`apps/api`).
- Modules are organised by business domain, exactly as the Part 6 table: tenancy-access, sites, register, capture, processing, review, assets, reconciliation, comparison, reports, evidence, notifications, billing and ai-gateway. Each lives in `apps/api/src/modules/<name>` with a public `index.ts`. Each owns its tables; others call its public interface.
- Boundaries are enforced in CI by dependency-cruiser (`.dependency-cruiser.cjs`): a module may import another only through its `index.ts`, and the shared platform layer may not import modules.
- One PostgreSQL 16 database. Every table carries `tenant_id` and has forced row-level security keyed on the session setting `app.tenant_id`. The API runs each request in one transaction that sets the application role and the tenant (`apps/api/src/platform/db.ts`). With no tenant set, nothing is visible.
- Every foreign key between tenant tables includes `tenant_id`, because foreign-key checks are not subject to row-level security.
- Records that must never change are append-only by privilege, by the absence of update and delete policies, and by triggers that refuse updates, deletes and truncation even from the table owner (`audit_events`, `proposals`, `asset_lines`, `review_decisions`, `usage_records`, `model_calls`).

## Consequences

- One transaction boundary, one backup, one place to look. Isolation holds even if a query in application code forgets a tenant filter.
- The API must never connect as a superuser or a role with BYPASSRLS for request handling; it switches to `domesday_app` in every transaction.
- One database is one scaling unit. The playbook order applies when limits are measured: fix queries, pool connections, cache, add replicas, split groups of tables vertically, and only then shard, by tenant.
- Schema changes follow expand and contract, and every launch migration is reversible (each migration has a `.down.sql`, tested in `db/test`).

## In this repository

`apps/api/src/modules`, `apps/api/src/platform`, `.dependency-cruiser.cjs`, `db/migrations/0001_foundation.sql` (`app_enable_tenant_isolation`), `db/test/migrations.test.ts`.
