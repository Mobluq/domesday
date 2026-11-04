# ADR-DMS-09: Price per site per month with walks included, not per asset or per photo

Status: Proposed: test in pilot

## Context

Pricing that surprises (credits per photo, charges for retries, steep jumps between tiers) is one of the flaws found across the market (Part 2). The PRD's pricing is a set of hypotheses to test in the pilot (Part 7): prices per site per month, billed annually in naira, with walks included and no charges per photo or per retry. A site is up to 60 rooms, larger sites count as two, and each walk includes up to 120 minutes of video.

## Decision

Meter sites, walks and video minutes, and show usage against the plan (DMS-133); show processing per walk in plain terms (DMS-134). Never charge per photo, per asset or per retry.

## Consequences

- The billing tables record the plan's site limit and video minutes per walk (`tenant_plans`, default 120 minutes) and append-only usage records (`usage_records`) for sites, walks and video minutes.
- No prices are in the code: the PRD's prices are hypotheses to be tested with at least 10 prospects before they are published.
- Cost per walk is tracked from day one (DMS-156) so margins can be checked against the Part 6 ceilings.
