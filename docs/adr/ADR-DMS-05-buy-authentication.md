# ADR-DMS-05: Buy authentication (Auth0, Clerk or WorkOS)

Status: Open

## Context

Sign-in is bought, not built (DMS-130): email and password with MFA for administrators and reviewers, and single sign-on with Microsoft Entra ID or Google for enterprise tenants. An administrator without MFA must set it up before reaching any data. The playbook says to buy authentication and keep secrets out of code.

## The decision to make

Which provider. The PRD lists Auth0, Clerk and WorkOS. The choice also has to fit the hosting region and transfer basis (ADR-DMS-06) and the SOC 2 or ISO 27001 path (Part 6).

## What the code does meanwhile

- The API depends on an `Authenticator` interface (`apps/api/src/platform/authz.ts`). The chosen provider's adapter will implement it.
- `StaticTokenAuthenticator` maps fixed tokens to principals for local development and tests only. The server refuses to start in production.
- MFA is enforced in the shared authorisation layer: a principal whose role requires MFA and who has not verified it gets `mfa_required` on every route.

## Consequences once decided

Partner users acting for a client tenant (DMS-120, DMS-121) need the provider's identity mapped to a partner tenant, with the client chosen per request; that mapping belongs in the adapter.
