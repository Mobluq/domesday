# ADR-DMS-07: Product name

Status: Open: test with buyers

## Context

The risk register (Part 8) notes that the name "Domesday" may read as "doomsday" to buyers. The mitigation is to test it with 10 buyers before launch. Open question 7 asks whether the name is final.

## The decision to make

Keep the name, or choose another, after the buyer test.

## What the code does meanwhile

The name appears in the package scope (`@domesday/...`), the component class prefix (`dms-`), the database role (`domesday_app`), the requirement prefix (DMS) and user-facing copy such as "Evidence by Domesday" (DMS-087). User-facing wording is kept in one file, `packages/domain/src/vocabulary/copy.ts`, so a rename of what people read is one change. Internal names can stay as they are.

## Consequences once decided

Renaming internal identifiers is optional and can follow expand and contract; renaming user-facing copy is cheap.
