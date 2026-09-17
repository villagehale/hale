/**
 * The ONE place a covered municipality is spelled for a human.
 *
 * Two callers render the `Municipality` token — the radar/nudge/sequence voice a parent
 * reads, and the de-identified activity search query — and before this module they
 * Title-Cased it independently. That agreed by construction only while every town's
 * name really was its token with the underscores opened out. Whitchurch-Stouffville
 * broke that: the token opens out to "Whitchurch Stouffville", which is neither the
 * legal hyphenated name nor what anyone in L4A says. A second title-caser would now be
 * a second place a town can be spelled, and the two could disagree — so there is one.
 */

/**
 * Towns whose token does NOT open out into the name people use. Exceptions only:
 * anything absent is derived, so a new municipality needs an entry here only when the
 * derivation and the town disagree.
 *
 * Whitchurch-Stouffville is the Town's legal name; "Stouffville" is what the Town
 * itself prints on the cover of its own Play Book and what a parent says out loud.
 */
const TOWN_LABEL_EXCEPTIONS: Readonly<Record<string, string>> = {
  whitchurch_stouffville: 'Stouffville',
};

/** 'richmond_hill' → 'Richmond Hill'. The municipality enum is an internal token; the
 * town's name is the public fact a parent recognises. */
export function townLabel(municipality: string): string {
  const exception = TOWN_LABEL_EXCEPTIONS[municipality];
  if (exception !== undefined) return exception;
  return municipality
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
