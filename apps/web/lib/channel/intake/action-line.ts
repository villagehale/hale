import type { ReplyLanguage } from '~/lib/channel/language';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import type { RadarDecision } from './radar-decide';

/**
 * The first reply says what to DO about the find: ONE deterministic line, composed by
 * the shell UNDER the radar message, carrying at most one hand-verified URL.
 *
 * WHY THE SHELL AND NOT THE MODEL, in four reasons the repo already wrote down.
 *
 *   1. The skill forbids it, in the same Boundaries block the open-now tense lives in:
 *      "Never write a clock time or a URL." Loosening that is a much larger change than
 *      adding a paragraph to Honest absences.
 *   2. The guard is already pointed the right way. `findInventedFacts` rejects any URL
 *      not present verbatim in a fact slot (lib/loop/voice/facts-lint.ts) and the
 *      composer degrades to the deterministic render on a non-empty result. Keeping the
 *      URL out of `radarVoiceContext` and out of `radarFactSlots` is what makes that
 *      guard load-bearing rather than aspirational.
 *   3. The house already composes link-bearing messages this way and says why:
 *      `intakeConnectorOffer` is "composed here and nowhere else, so no later fitting
 *      can split the sentence from the URLs it is about" (intake/copy.ts).
 *   4. There is no warmth to add to a URL. That is what makes this a STATE RECEIPT in
 *      the house's own vocabulary (channel/router/copy.ts) rather than a template
 *      dodging D25 — the warmth is the composed sentence directly above it.
 *
 * WHAT IT MAY NEVER SAY. Not "there's still room", not "spots left", not "go now before
 * it fills". Hale has not read the page; it knows the morning the town opened and the
 * access mode the feed published, and nothing else. The registration layer states that
 * boundary for itself (registration/sequence/shortlist.ts).
 */

/** The parent's next move. Five, because the two `register_later` forms are two
 * different facts about the same page — the listings are browsable, or they are not —
 * and the dark probe's whole job is to count which move each real family would get. */
export type ActionMove =
  | 'register_open'
  | 'register_later_preview'
  | 'register_later'
  | 'sign_up'
  | 'just_go';

/** Why no line was emitted. Every one is a NAMED outcome rather than an empty string:
 * the flag is off for a night of real intakes before one parent sees a URL, and what
 * that night is worth is entirely in being able to tell these apart (rule #11). */
export type ActionLineHeld =
  /** Nothing in the decision implies an action — the mapping-only first reply. */
  | 'no_move'
  /**
   * A pick with no recorded access: a model-discovered row, or a civic one projected
   * before the column existed. Telling a parent to turn up at a session that wants a
   * ticket is the failure this refuses to risk (R4).
   *
   * It is ALSO, today, the whole of R1's accounting. The brief budgeted a separate
   * `unverified_source` for "the row has a url but its source is not the civic
   * registry" — and that state cannot be constructed: only the civic projection writes
   * `village_candidates.access`, so a pick whose access is known is a civic row by
   * construction, and a model-discovered one is already and truthfully counted here.
   * Shipping an enum member nothing can emit is a door before the thing that opens it.
   * When an adapter writes `access` without a trustworthy url, that is when the reason
   * earns its place.
   */
  | 'access_unknown'
  /** The row carries no url. `village_candidates.source_url` is nullable, so this is a
   *  real null to fail closed on rather than an impossible one. */
  | 'no_url'
  /** The url is not printable GSM-7. HELD, never folded: `asciiCopy` exists to make
   *  town-written text safe and applying it to a URL would silently break the link
   *  (R5). The spots copy makes the same call - throw or refuse, never trim. */
  | 'not_gsm7'
  /** The line would push the payload past the segment budget. Assigned by the shell
   *  that measures it, never here. */
  | 'over_budget'
  /** Computed, logged, and not appended. Assigned by the shell (see the dark flag). */
  | 'flag_off';

export type ActionLine =
  | { line: string; url: string; move: ActionMove }
  | { line: null; held: ActionLineHeld };

/**
 * The dark flag, and it gates the URL and ONLY the URL.
 *
 * STRICT equality on the literal 'true', the `f14Enabled` pattern and its reason
 * verbatim: `vercel env add` from a piped `echo` stores a TRAILING NEWLINE, so a value
 * that prints as `true` is really 'true\n' and a truthiness check would read that as
 * ON. Set it with `printf '%s'`.
 *
 * Its own flag rather than F14's: intake is the front door and is not F14-gated at all.
 */
export const FIRST_REPLY_ACTION_LINE_ENV = 'FIRST_REPLY_ACTION_LINE';

export function firstReplyActionLineEnabled(): boolean {
  return process.env[FIRST_REPLY_ACTION_LINE_ENV] === 'true';
}

/**
 * The copy, one line per move per language.
 *
 * `{url}` is substituted verbatim and never folded. `{when}` is substituted with the
 * session's own time and its leading comma TOGETHER, so a row that carries no time
 * loses the clause rather than printing an empty one — both columns are written by the
 * same projection insert, so a drop-in without a time is not reachable from production
 * data and the branch exists only because the type allows it.
 *
 * FR is written and tested but unwired: the first reply has no language of its own yet
 * (intake/machine.ts says so where it appends the watch offer), so `radar.ts` passes
 * 'en'. It is GSM-7 by hand — `é`, `è`, `à`, `ù`, `ì` and `ò` are in the basic alphabet
 * while `ê`, `î`, lowercase `ç` and `œ` are not — and the encoding scan over this file
 * is what keeps the next French sentence honest.
 */
const ACTION_LINE_COPY: Record<ReplyLanguage, Record<ActionMove, string>> = {
  en: {
    register_open: 'The page is here: {url}',
    register_later_preview: 'The listings are up already if you want a look: {url}',
    register_later: "Here's the page: {url}",
    sign_up: 'Sign-up needed for this one: {url}',
    just_go: 'No sign-up needed{when}: {url}',
  },
  fr: {
    register_open: 'La page est ici : {url}',
    register_later_preview: 'Les programmes sont deja en ligne si vous voulez voir : {url}',
    register_later: 'Voici la page : {url}',
    sign_up: "Il faut s'inscrire pour celle-la : {url}",
    just_go: "Pas d'inscription{when} : {url}",
  },
};

function render(
  move: ActionMove,
  language: ReplyLanguage,
  url: string,
  when: string | null,
): ActionLine {
  // The URL is the one string in this payload Hale did not write, and it is the one
  // string that must survive byte-for-byte. A url outside the printable basic alphabet
  // is held rather than folded: folding it would send the family to a different address.
  if (!isPrintableGsm7Basic(url)) return { line: null, held: 'not_gsm7' };
  const line = ACTION_LINE_COPY[language][move]
    .replace('{when}', when === null ? '' : `, ${when}`)
    .replace('{url}', url);
  return { line, url, move };
}

/**
 * The one line for one decision, or the named reason there is none.
 *
 * THE CASCADE IS R2: exactly one Hale-chosen URL per message, and the registration rung
 * outranks the pick, because a parent handed a registration morning AND a Saturday
 * drop-in has one thing to do about the first and can read the second at leisure.
 *
 * `language` is required rather than defaulted: the absence of a language is a value a
 * caller states, never one it falls into (rule #11).
 */
export function renderActionLine(decision: RadarDecision, language: ReplyLanguage): ActionLine {
  const absence = decision.registrationAbsence;
  if (absence?.stillOpen) {
    return render('register_open', language, absence.stillOpen.registerUrl, null);
  }

  const registration = decision.registrationLine;
  if (registration) {
    return render(
      registration.previewUp ? 'register_later_preview' : 'register_later',
      language,
      registration.registerUrl,
      null,
    );
  }

  const pick = decision.weekendPick;
  if (pick === null) return { line: null, held: 'no_move' };
  if (pick.access === 'unknown') return { line: null, held: 'access_unknown' };
  if (pick.verifiedUrl === null) return { line: null, held: 'no_url' };
  return render(
    pick.access === 'register_at_venue' ? 'sign_up' : 'just_go',
    language,
    pick.verifiedUrl,
    pick.access === 'drop_in' ? pick.when : null,
  );
}
