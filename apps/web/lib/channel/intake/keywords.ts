import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * VIL-237 · M2 — the CASL keyword guards, which run BEFORE any model call.
 *
 * STOP is a legal instruction, not a message to be interpreted. Routing it through
 * an LLM would make unsubscribing probabilistic — a bad day for the model is a CASL
 * violation and a parent who asked to be left alone and wasn't. So the keywords are
 * matched deterministically here, first, every time; the model never sees them.
 *
 * Matching is EXACT on the normalized body (trimmed, case-folded, surrounding
 * punctuation stripped) — deliberately not a substring search. "Please stop sending
 * me swim class times" is a sentence about swimming, not an unsubscribe, and treating
 * it as one would silently drop a family who was still talking to us. A parent who
 * means STOP sends STOP; that is the convention carriers train them on.
 *
 * IT IS BILINGUAL. The CTA's Canadian Common Short Code Compliance Policies (v2.1,
 * January 2026, §3.1) make five keywords mandatory for every program — STOP, ARRET,
 * HELP, AIDE, INFO — "regardless of the intended audience", and texting ARRET or AIDE
 * "must return a French response". That document is SHORT-CODE policy and Hale sends
 * from a Canadian long code (twilio/config.ts), so it does not bind this program; Hale
 * adopts its standard voluntarily, because a francophone parent typing ARRET at a
 * Canadian number means it whatever the sender's numbering plan is. DEBUT is here for
 * the same reason and not even by that standard: START is the word the STOP
 * acknowledgment offers back, and a French acknowledgment offering an English-only word
 * would be the same broken promise the French half of copy.ts exists to end.
 *
 * WHICH LANGUAGE TO ANSWER IN IS DECIDED HERE, and that is the point of returning it
 * rather than a bare keyword. `replyLanguage` (lib/channel/language.ts) reads a message
 * for French evidence, and a body that IS a keyword is one token long: it holds `arret`
 * (which that detector does claim) but also `aide` — an English noun it deliberately
 * refuses to decide on — and `debut`, which it has never heard of. Asking it would have
 * answered AIDE in English, which is precisely what §3.1 forbids. The keyword's own
 * language is not evidence to be weighed, it is a fact about the word, so it travels
 * WITH the match and no second reader can disagree with it.
 *
 * WHAT THIS FILE DOES NOT ASSERT (VIL-348). It used to open a paragraph with "verified
 * against the platform's own configuration in this repo" and then describe a Twilio
 * account — which senders the transport names, whether the opt-out list is on, which
 * words are in it. That sentence was true when it was written and false three days
 * later, when the Messaging Service landed (#516), and nobody noticed for four weeks,
 * because NOTHING IN THE SYSTEM CAN SEE THAT CONFIGURATION. A comment is the one place a
 * claim can rot without a test going red.
 *
 * So the contract is only about this code: Hale matches the six words below
 * deterministically and answers each in its own language. Where the PROVIDER has already
 * matched and already answered, the inbound arrives carrying
 * `providerAnsweredKeyword` (intake/transport.ts) and Hale does every piece of its
 * ledger work and stays quiet — two confirmations for one STOP is one too many to a
 * parent who asked to be left alone. Where it does not, Hale answers. Both behaviours
 * are tested, so neither depends on knowing which one is live.
 *
 * THE ONE ASYMMETRY A CONFIGURATION CAN STILL CREATE, named because code cannot close
 * it: an opt-out list that holds STOP but not DEBUT will keep refusing sends to a number
 * whose owner has since texted DEBUT and been re-enrolled here. Hale's ledger would say
 * enrolled and nothing would arrive. `handleKeyword`'s re-enrolment branch treats a
 * permanent refusal of its own acknowledgment as a named outcome rather than an
 * exception for exactly this reason; the remedy itself is configuration — the provider's
 * localized keyword set has to hold every word Hale prints.
 *
 * OBSERVED, NOT ASSUMED: on 2026-08-18 Twilio's built-in set was English only
 * (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPTOUT, START/YES/UNSTOP, HELP/INFO)
 * and localized keywords existed only as explicit entries on a Messaging Service with
 * Advanced Opt-Out configured. That is a dated reading of someone else's product, not a
 * premise anything below depends on.
 */

export type IntakeKeyword = 'stop' | 'help' | 'start';

export interface IntakeKeywordMatch {
  readonly keyword: IntakeKeyword;
  /** The language of the WORD, and therefore of the reply it is owed. */
  readonly language: ReplyLanguage;
}

/**
 * The vocabulary, per keyword and per language. Written accent-free because the lookup
 * folds accents before reading it (see {@link keywordToken}) — `arret` is the entry that
 * ARRET, ARRÊT and arrêt all arrive as.
 */
const VOCABULARY: Record<ReplyLanguage, Record<IntakeKeyword, readonly string[]>> = {
  en: {
    stop: ['stop', 'unsubscribe', 'end', 'quit', 'cancel'],
    help: ['help', 'info'],
    start: ['start'],
  },
  fr: {
    stop: ['arret'],
    help: ['aide'],
    start: ['debut'],
  },
};

const MATCHES: ReadonlyMap<string, IntakeKeywordMatch> = new Map(
  Object.entries(VOCABULARY).flatMap(([language, byKeyword]) =>
    Object.entries(byKeyword).flatMap(([keyword, words]) =>
      words.map(
        (word) =>
          [
            word,
            { keyword: keyword as IntakeKeyword, language: language as ReplyLanguage },
          ] as const,
      ),
    ),
  ),
);

/** Case-fold, trim, and drop surrounding punctuation/whitespace ("STOP." → "stop"). */
export function normalizeKeyword(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}

/**
 * The token to look up: the normalized body with its accents folded onto their base
 * letters, the same fold `normalizeReply` (affirmative.ts) and `words` (language.ts)
 * already apply next door.
 *
 * Folding rather than listing spellings is what makes ARRÊT, ARRET and a phone that
 * sends the circumflex as a separate combining mark one entry instead of three — and the
 * third is the one an enumerated list would have dropped, because a decomposed accent is
 * invisible on the screen and different as a string. The fold is local to this lookup
 * rather than folded into {@link normalizeKeyword}: three other surfaces (health, party
 * and registration replies) share that normalizer to read English-only vocabularies and
 * are not part of the CASL contract.
 */
function keywordToken(body: string): string {
  return normalizeKeyword(body)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

/** The CASL keyword this body IS and the language it is owed a reply in, or null when
 * it is ordinary conversation. */
export function matchKeyword(body: string): IntakeKeywordMatch | null {
  return MATCHES.get(keywordToken(body)) ?? null;
}
