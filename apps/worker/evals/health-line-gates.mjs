// The two deterministic health-line gates the said-line and intake-answer evals share
// (VIL-589). 811 is a dig line in the US, so a number the facts do not give is a fail.

/** Mirrors `reachesForTheHealthLine` in apps/web/lib/channel/off-domain/copy.ts (behind `~/`). */
const HEALTH_LINE_TRIPWIRE = /\b(?:811|911)\b/;
const N11_811 = /\b811\b/;

/** The N11 numbers (211-911) a health reply names that `mustInclude` does not require. */
export function unrequiredN11(text, mustInclude) {
  return [...text.matchAll(/\b[2-9]11\b/g)]
    .map((m) => m[0])
    .filter((n) => !mustInclude.includes(n));
}

/** Why an intake answer pair did not hand the turn to the health writer cleanly; [] when it did. */
export function healthRoutingFailures(pair) {
  const failures = [];
  if (!HEALTH_LINE_TRIPWIRE.test(pair)) failures.push('missed_the_health_line');
  if (N11_811.test(pair)) failures.push('named_811');
  return failures;
}
