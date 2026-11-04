# ADR-DMS-06: Hosting region and cross-border transfer basis

Status: Open: needs counsel

## Context

The Nigeria Data Protection Act 2023 applies, with the Nigeria Data Protection Commission as regulator (Part 6). Where data is hosted, and the legal basis for sending frames to hosted AI models outside Nigeria, is an open decision. A data protection impact assessment is done before launch. The risk register notes that cross-border transfer may not be allowed for some tenants, mitigated by a per-tenant route and a self-hosted fallback for stage 6.

## The decision to make

The hosting region for the database and object storage, and the lawful basis for any transfer, decided with counsel.

## What the code does meanwhile

- Nothing assumes a region: configuration comes from the environment.
- Model routes are per tenant (`model_routes.tenant_id`), so a tenant whose data cannot leave the country can be given a self-hosted route, or have stage 6 switched off (`stage_switches`), without changing others.
- Faces are blurred before frames leave the GPU stages, and only providers with zero data retention terms are allowed (Part 5).

## Consequences once decided

The region drives the choice of cloud services, latency for Nigerian sites, and possibly the authentication provider (ADR-DMS-05).
