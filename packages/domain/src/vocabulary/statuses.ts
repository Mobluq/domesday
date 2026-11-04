import { defineVocabulary, type CodeOf } from './define';

/**
 * DMS-071: the change status of an asset between two approved walks.
 * "Not seen" is a question, not an accusation (DMS-063, Part 5 principle 3).
 */
export const ChangeStatus = defineVocabulary({
  unchanged: 'Unchanged',
  not_seen: 'Not seen on this walk',
  moved: 'Moved',
  new: 'New',
  condition_worse: 'Condition worse',
  condition_better: 'Condition better',
  room_not_filmed: 'Room not filmed',
});
export type ChangeStatus = CodeOf<typeof ChangeStatus>;

/**
 * Part 5 (the comparison experience): the order changes are listed in.
 * Rooms not filmed follow the changes; unchanged assets collapse into one count (DMS-074).
 */
export const CHANGE_DISPLAY_ORDER: readonly ChangeStatus[] = Object.freeze([
  'not_seen',
  'moved',
  'new',
  'condition_worse',
  'condition_better',
  'room_not_filmed',
  'unchanged',
]);

/** Statuses that count as a change in the headline ("9 changes since ..."). */
export const COUNTED_AS_CHANGE: readonly ChangeStatus[] = Object.freeze([
  'not_seen',
  'moved',
  'new',
  'condition_worse',
  'condition_better',
]);

/** DMS-060: the result of matching an approved line to the imported register. */
export const ReconStatus = defineVocabulary({
  found: 'Found',
  found_elsewhere: 'Found elsewhere',
  unrecorded: 'Unrecorded',
  not_seen: 'Not seen on this walk',
});
export type ReconStatus = CodeOf<typeof ReconStatus>;

/** DMS-036: the 4-point condition scale, best first. */
export const ConditionGrade = defineVocabulary({
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  not_working_or_unsafe: 'Not working or unsafe',
});
export type ConditionGrade = CodeOf<typeof ConditionGrade>;

/** 0 for good up to 3 for not working or unsafe. A higher number is a worse condition. */
export function conditionSeverity(grade: ConditionGrade): number {
  return ConditionGrade.values.indexOf(grade);
}

/** DMS-037: every proposal carries a confidence band. */
export const ConfidenceBand = defineVocabulary({
  high: 'High',
  medium: 'Medium',
  low: 'Low',
});
export type ConfidenceBand = CodeOf<typeof ConfidenceBand>;

/** DMS-050: the review queue shows low confidence first. */
export const REVIEW_ORDER: readonly ConfidenceBand[] = Object.freeze(['low', 'medium', 'high']);

/** DMS-010: the status of a room within one walk. A skipped room needs a reason. */
export const RoomWalkStatus = defineVocabulary({
  not_started: 'Not started',
  filmed: 'Filmed',
  skipped: 'Skipped',
});
export type RoomWalkStatus = CodeOf<typeof RoomWalkStatus>;
