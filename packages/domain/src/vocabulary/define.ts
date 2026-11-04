/**
 * A closed set of codes, each with the exact user-facing label the PRD uses.
 *
 * Codes are the stable machine values shared by the API (OpenAPI enums), the
 * database (CHECK constraints) and the apps. Labels are what people read.
 */
export interface Vocabulary<Code extends string> {
  /** Every code, in the order the PRD lists them. */
  readonly values: readonly Code[];
  /** The user-facing label for each code. */
  readonly labels: Readonly<Record<Code, string>>;
  /** True when the value is one of this vocabulary's codes. */
  is(value: unknown): value is Code;
  /** The user-facing label for a code. */
  label(code: Code): string;
}

/** The union of codes in a vocabulary. */
export type CodeOf<V> = V extends Vocabulary<infer C> ? C : never;

export function defineVocabulary<const Labels extends Record<string, string>>(
  labels: Labels,
): Vocabulary<Extract<keyof Labels, string>> {
  type Code = Extract<keyof Labels, string>;
  const frozenLabels = Object.freeze({ ...labels }) as Readonly<Record<Code, string>>;
  const values = Object.freeze(Object.keys(frozenLabels) as Code[]);
  return Object.freeze({
    values,
    labels: frozenLabels,
    is: (value: unknown): value is Code => typeof value === 'string' && Object.hasOwn(frozenLabels, value),
    label: (code: Code): string => frozenLabels[code],
  });
}
