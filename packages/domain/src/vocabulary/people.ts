import { defineVocabulary, type CodeOf } from './define';

/** DMS-131: roles. Every role can be scoped to a site or a group of sites (DMS-132). */
export const Role = defineVocabulary({
  tenant_administrator: 'Tenant administrator',
  financial_controller: 'Financial controller',
  facilities_manager: 'Facilities manager',
  site_manager: 'Site manager (capture)',
  reviewer: 'Reviewer',
  internal_auditor: 'Internal auditor',
  read_only: 'Read-only',
  partner: 'Partner',
});
export type Role = CodeOf<typeof Role>;

/**
 * DMS-075: outcomes of an investigation into a not-seen asset.
 *
 * The PRD lists "found, transferred, disposed, written off, lost or stolen".
 * Splitting "lost or stolen" into two outcomes is a proposal recorded in
 * docs/judgement-calls.md. Only these outcomes may ever carry the words
 * "lost" or "stolen", and only once a person has recorded one (DMS-063).
 */
export const InvestigationOutcome = defineVocabulary({
  found: 'Found',
  transferred: 'Transferred',
  disposed: 'Disposed',
  written_off: 'Written off',
  lost: 'Lost',
  stolen: 'Stolen',
});
export type InvestigationOutcome = CodeOf<typeof InvestigationOutcome>;

/** DMS-075, DMS-113: an investigation is open until someone records an outcome. */
export const InvestigationStatus = defineVocabulary({
  open: 'Open',
  closed: 'Outcome recorded',
});
export type InvestigationStatus = CodeOf<typeof InvestigationStatus>;
