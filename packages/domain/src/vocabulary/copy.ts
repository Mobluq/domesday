/**
 * Fixed user-facing wording taken from the PRD. Keep these exact: QA tests
 * against them and the voice rules in Part 7 depend on them.
 */
export const UI_COPY = Object.freeze({
  /** DMS-103: shown with a red indicator whenever recording is on. */
  recordingNotice: 'Recording spaces for asset count',
  /** DMS-013 and Part 5: live capture prompts. */
  slowDown: 'Slow down',
  tooDark: 'Too dark, turn on the lights',
  lensBlocked: 'Lens blocked',
  /** DMS-007: flag on items below the capitalisation threshold. */
  belowThreshold: 'Below threshold',
  /** DMS-087: shown on every report cover. */
  evidenceBy: 'Evidence by Domesday',
  /** DMS-086: the PRD gives the wording for a failed check; the wording for a passed check is ours. */
  verificationMatches: 'Matches the issued report',
  verificationDoesNotMatch: 'Does not match the issued report',
  /** Part 7 example report cover line. */
  reportCoverMethod: 'What was filmed, what was not, and how each line was confirmed.',
});
