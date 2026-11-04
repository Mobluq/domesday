# ADR-DMS-03: Stage 6 uses a hosted multimodal model through the gateway at launch, with a self-hosted fallback evaluated in Phase 0

Status: Open: decide at the benchmark gate

## Context

Stage 6, describe and grade, gives each tracked item a category from the tenant's list, a short description, make and model, and a condition grade with a reason (Part 5). The PRD's approach is a hosted multimodal model called through the AI gateway, with output forced into a fixed JSON schema, the tenant's category list as the only allowed values, and temperature 0. Cost per video minute has ceilings (Part 6 targets: up to US$0.20 on a first walk and up to US$0.06 on a repeat walk), only providers with zero data retention terms are allowed, and sending frames outside Nigeria is an open legal question (ADR-DMS-06).

## The decision to make

Hosted model through the gateway at launch, or the self-hosted fallback, decided at the Phase 0 benchmark gate. The gate (Part 8, all targets): line acceptance of at least 75%, serial reading of at least 85%, missing-item recall of at least 85%, face blur recall of at least 99%, and first-walk cost under US$0.30 per video minute.

## What the code does meanwhile

- The `ai-gateway` module routes only to enabled providers with zero data retention (`chooseRoute`), and the database refuses a route without it (`model_routes.zero_data_retention_only`).
- Every hosted-model call has a timeout and is retried once after a jittered pause, the only retry layer for these calls (`callWithGatewayPolicy`).
- Each stage can be switched off per tenant (`stage_switches`). No model is called anywhere yet.

## Consequences once decided

A hosted model means per-call cost and a cross-border transfer to justify; a self-hosted model means GPU capacity and a model to maintain. Either way, every proposal records its model and prompt versions so walks can be reprocessed and compared (Part 5).
