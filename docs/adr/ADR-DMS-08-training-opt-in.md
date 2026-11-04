# ADR-DMS-08: Training on customer data is opt-in only, in writing

Status: Proposed

## Context

Reviewer corrections are stored as labelled examples for evaluation and, only with the tenant's consent, for model improvement (DMS-055). Customer footage and corrections are used to improve models only where the tenant has opted in, in writing; otherwise only to measure that tenant's accuracy (Part 5). Training on customer footage without written consent is listed among the dark patterns to refuse (Part 7).

## Decision

Training use is off by default for every tenant and switched on only with consent in writing.

## Consequences

- `tenants.training_consent` defaults to false, and the database refuses `true` unless the reference to the written consent and the time it was recorded are both present (`training_consent_in_writing`).
- Any future export of examples for training must filter on this flag; examples from tenants without consent stay in that tenant's own accuracy metrics.
