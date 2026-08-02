import { matchPhrase, normalizeReply } from '~/lib/channel/affirmative';
import { matchKeyword } from '~/lib/channel/intake/keywords';

/**
 * VIL-220 · C1 — the approval grammar. No model, ever.
 *
 * A parent answering "yes" to a drafted action is giving CONSENT (rule #4), and the
 * whole point of a fast-path is that consent is never inferred. So this is a closed
 * vocabulary matched against the WHOLE message: a body either is one of these commands
 * or it is conversation, and there is no middle verdict. Anything this declines falls
 * through to the coach, which is allowed to be wrong in a way an approval is not.
 *
 * The vocabulary itself moved to `lib/channel/affirmative.ts` (VIL-260): M6's caregiver
 * confirmation held a second, different copy of it, and every word on one list and not
 * the other was an answer one of the two surfaces silently dropped. What stays HERE is
 * everything specific to approvals — the ordinal, the undo verb, and the CASL refusal.
 *
 * Two properties do the work:
 *
 *   WHOLE-STRING. Never a substring search — the discipline the CASL keywords and M8's
 *   health replies already keep, and for the same reason: "yes please move swim to
 *   Tuesday" contains "yes" and is a scheduling request, not an approval. Matching a
 *   prefix would execute a calendar write the parent never confirmed.
 *
 *   NO OVERLAP WITH CASL. 'cancel' is a natural English refusal AND a carrier-
 *   recognised STOP synonym, so it is deliberately absent from the shared NO set; the
 *   `matchKeyword` guard below is structural rather than a comment, so a future edit to
 *   either vocabulary cannot quietly turn an unsubscribe into an approval decline.
 */

export type FastPathVerb = 'yes' | 'no' | 'undo';

export interface FastPathCommand {
  verb: FastPathVerb;
  /** The 1-based ordinal in the numbered list Hale texted, or null for a bare command. */
  index: number | null;
}

const UNDO_PHRASES = new Set(['undo', 'undo that', 'undo it', 'revert']);

/**
 * The largest ordinal a numbered SMS list can name, and therefore the cap on the list
 * itself — copy.ts imports this rather than picking its own, so the grammar can never
 * refuse a number Hale actually printed. Three is the voice rules' own limit on list
 * items over SMS. A bigger ordinal is a typo or a different sentence, and answering it
 * by clamping would approve a different action than the parent meant.
 */
export const MAX_LISTED_APPROVALS = 3;

/**
 * The command this body IS, or null when it is conversation.
 *
 * Anything the CASL matcher claims is refused outright: those words are handled before
 * a message ever reaches this router, and a second reading of them here could only ever
 * disagree with the first.
 */
export function matchFastPath(body: string): FastPathCommand | null {
  if (matchKeyword(body)) return null;

  // Filler is stripped BEFORE the ordinal is read (normalizeReply does it), so
  // "yes 2 please" and "yes 2" are the same command — a trailing "please" is not part
  // of the number.
  const normalized = normalizeReply(body);
  if (!normalized) return null;

  // A trailing run of digits is the ordinal, whether or not a space separates it
  // ("yes 2", "yes #2", "yes2" all normalize into one of these two shapes).
  const split = /^(.*?)\s*(\d+)$/.exec(normalized);
  const phrase = split ? (split[1] as string) : normalized;
  const digits = split ? (split[2] as string) : null;
  if (!phrase) return null;

  let index: number | null = null;
  if (digits !== null) {
    const parsed = Number.parseInt(digits, 10);
    // Out of range is a REFUSAL, not a clamp: "yes 100" is not an approval of item 3.
    if (parsed < 1 || parsed > MAX_LISTED_APPROVALS) return null;
    index = parsed;
  }

  if (UNDO_PHRASES.has(phrase)) {
    // Undo names the last thing Hale did, not a row in a list, so an ordinal on it is
    // a sentence we cannot read — better answered by the coach than guessed at here.
    return index === null ? { verb: 'undo', index: null } : null;
  }
  const affirmation = matchPhrase(phrase);
  if (affirmation === 'unclear') return null;
  return { verb: affirmation, index };
}
