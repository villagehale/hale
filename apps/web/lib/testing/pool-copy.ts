/**
 * THE TWO MECHANICAL THINGS A VARIANT POOL HAS TO BE, in one place because four pools in
 * three lanes are held to them (docs/voice.md, "The two authoring constraints that are
 * tests"): no two members may be the same sentence with a word changed, and no member may
 * ask a question a bare YES or NO answers.
 *
 * TEST-ONLY: nothing in production imports it.
 *
 * ── one · the near-duplicate detector ────────────────────────────────────────────────
 *
 * "Are two of these the same sentence with a word changed?" — the measured detector,
 * lifted from apps/site/app/landing.test.ts so a variant pool is held to the same bar the
 * landing copy already is. TEST-ONLY: nothing in production imports it.
 *
 * The calibration is the site's, verbatim, because the threshold is the part that took
 * measuring:
 *
 *   An exact-substring pin does not hold this: the copy it was written against said
 *   "I'll run THAT morning with you" against the transcript's "I'll run THE morning with
 *   you" and passed. So the comparison is per sentence pair on word SETS, which a
 *   one-word edit barely moves. Measured: this copy's worst pair is the two "Halton Hills
 *   fall recreation opens Tuesday at 7:00 a.m." openings at 0.50 — two messages that
 *   share a fact, which they must — and the near-copy above scores 0.79. The line is
 *   drawn at 0.65, with room either side.
 *
 * A five-member pool whose members are one sentence with a synonym swapped is not a pool,
 * and this is the only mechanical way to say so.
 */

/** The line, measured rather than chosen. */
export const NEAR_DUPLICATE_THRESHOLD = 0.65;

export function wordSet(sentence: string): Set<string> {
  return new Set(sentence.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Jaccard overlap of two sentences' word sets: shared / union. */
export function wordOverlap(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

/** Every pair that is too alike, worst first. Empty is the pass. */
export function nearDuplicatePairs(
  members: readonly string[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD,
): Array<{ a: string; b: string; overlap: number }> {
  const pairs: Array<{ a: string; b: string; overlap: number }> = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i] as string;
      const b = members[j] as string;
      const overlap = wordOverlap(a, b);
      if (overlap >= threshold) pairs.push({ a, b, overlap });
    }
  }
  return pairs.sort((x, y) => y.overlap - x.overlap);
}

// ── two · the bare-yes-no question (docs/voice.md rule 11) ─────────────────────────────

/**
 * The auxiliaries and modals a question may not open with.
 *
 * This is the mechanical half of rule 11, and the rule is mechanical so that it CAN be a
 * test. `readCadenceWord` maps a whole-string "no" / "non" to cadence OFF and the reply
 * handler reads it before anything else (checkin/reply.ts), for as long as the lane holds
 * the floor — so "Did Mia make it to swim?" is a question a parent can answer honestly
 * and thereby turn the evening off for good, with CHECK_IN_OFF_ACK as the only notice.
 * "How did swim go?" cannot be answered "No".
 */
const AUXILIARY_OPENERS = [
  'did',
  'do',
  'does',
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'can',
  'could',
  'will',
  'would',
  'should',
] as const;

/**
 * The questions in `body` that a bare yes or no answers. Empty is the pass.
 *
 * A question is a run of text ending in "?". Rule 11 says "AFTER THE OPTIONAL NAME SLOT",
 * and that clause is load-bearing: "Mia, did swim go ok?" is exactly as answerable by a
 * bare "no" as "Did swim go ok?" is, and reading only the first word of the whole run
 * would pass it. So the run is split on the separators a name slot or a run-up clause ends
 * with — a comma, or a spaced dash, colon or semicolon — and EVERY segment's opening word
 * is checked. A question with no separator in it is one segment, which is the common case.
 *
 * Intra-word hyphens are left alone (the dash must be spaced), so "How was drop-off?" is
 * one segment. A body with no question at all yields nothing, which is correct — an ack
 * that asks nothing cannot be answered wrongly.
 *
 * THE SEPARATOR LIST IS THE CLASS, not the two shapes the first members happened to use.
 * A name slot can end on a line break or a slash as readily as on a comma, and a rule that
 * reads past `Mia,` and stops at `Mia /` is a gate that passes the next member somebody
 * writes — which is the whole failure mode of a negative assertion.
 */
export function bareYesNoQuestions(body: string): string[] {
  return (body.match(/[^.!?]*\?/g) ?? [])
    .map((question) => question.trim())
    .filter((question) =>
      question.split(/,\s*|\s*\n\s*|\s+[-–—:;/]\s+/).some((segment) => {
        const first = segment.toLowerCase().match(/[\p{L}']+/u)?.[0] ?? '';
        return (AUXILIARY_OPENERS as readonly string[]).includes(first);
      }),
    );
}
