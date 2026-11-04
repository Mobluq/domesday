# ADR-DMS-04: Unblurred originals kept in a restricted write-once vault; reviewers and reports see blurred derivatives only

Status: Open: decide at the benchmark gate, with counsel

## Context

Footage of workplaces can capture identifiable people. Faces are blurred before any reviewer or report sees a frame (DMS-100), screens and documents by default (DMS-101), and unblurred originals are viewable only by two named roles, each view logged with a reason (DMS-102). Originals are stored write-once for the retention period, and nobody, including Domesday staff, can alter or delete them early (DMS-090).

## The decision to make

Whether the restricted vault holds the unblurred originals as described, decided at the benchmark gate with counsel (the face blur recall target is at least 99%, and the data protection impact assessment is due before launch).

## What the code does meanwhile

- The schema keeps the original (`clips.storage_key`, write-once) apart from blurred derivatives (`frames.blurred_storage_key`).
- The API specification only ever returns blurred derivatives, through signed URLs that expire after 5 minutes. `openUnblurredOriginal` needs `evidence:read_unblurred`, held by exactly two roles, and a reason; it is specified but not built.
- The two roles are not named in the PRD. The proposal is internal auditor and tenant administrator (docs/judgement-calls.md).
- Verified originals are copied to write-once storage locked until the retention date. Retention can be extended but never shortened (`clips_guard`).

## Consequences once decided

A separate vault adds a storage location and an access path to audit, but keeps the restricted material small and easy to reason about.
