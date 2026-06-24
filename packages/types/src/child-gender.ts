/**
 * A child's gender, captured as an OPTIONAL field during onboarding (rule #1:
 * sensitive — asked, never required, and defaulting to `unspecified` when the
 * parent skips it). Stored on the child row as a non-null enum so a missing
 * answer is explicit (`unspecified`), never a SQL null to reason about.
 *
 * This is the single source of truth: the wizard picker, the persist path, and
 * server-side validation all read CHILD_GENDERS / ChildGender, so no gender
 * value is a magic string duplicated across the codebase.
 */

export type ChildGender = 'boy' | 'girl' | 'nonbinary' | 'unspecified';

/** The default when a parent skips the (optional) gender question. */
export const DEFAULT_CHILD_GENDER: ChildGender = 'unspecified';

/** Ordered list of the selectable genders with their display labels. */
export const CHILD_GENDERS: readonly { value: ChildGender; label: string }[] = [
  { value: 'boy', label: 'Boy' },
  { value: 'girl', label: 'Girl' },
  { value: 'nonbinary', label: 'Non-binary' },
  { value: 'unspecified', label: 'Prefer not to say' },
];

const GENDER_VALUES: ReadonlySet<string> = new Set(CHILD_GENDERS.map((g) => g.value));

/** True iff `value` is a known gender. Pure — no I/O. */
export function isChildGender(value: string): value is ChildGender {
  return GENDER_VALUES.has(value);
}

/**
 * Coerce a client value to a known gender, falling back to `unspecified` for an
 * unknown or empty value — so a missing or garbage answer is always the explicit
 * "prefer not to say", never persisted as-is. Pure — no I/O.
 */
export function parseChildGender(raw: string | undefined | null): ChildGender {
  if (raw && isChildGender(raw)) {
    return raw;
  }
  return DEFAULT_CHILD_GENDER;
}
