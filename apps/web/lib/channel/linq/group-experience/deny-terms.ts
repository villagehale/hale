import { DENY_TERM_MIN_LETTERS } from './privacy';

/** One household's private terms, as `readFamilyPrivateSlice` holds them. */
export interface DenySlice {
  children: readonly string[];
  memory: readonly string[];
  email: readonly string[];
  signups: readonly string[];
  /** Calendar entries as `Title · when`; only the title is a term. */
  calendar: readonly string[];
}

/**
 * The terms no group line may carry: every household's children, memory facts, mail
 * subjects, sign-ups and calendar titles. `denyListForChat` reads the slices; the eval
 * derives its deny terms from the same function on its seeded households.
 */
export function denyTermsFromSlices(slices: readonly DenySlice[]): string[] {
  const tokens: string[] = [];
  for (const slice of slices) {
    tokens.push(...slice.children, ...slice.memory, ...slice.email, ...slice.signups);
    // Calendar titles block leaks too; the clock suffix is not a deny token.
    tokens.push(...slice.calendar.map((entry) => entry.split(' · ')[0] ?? ''));
  }
  return tokens.filter((token) => token.trim().length >= DENY_TERM_MIN_LETTERS);
}
