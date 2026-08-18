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
 * IT IS BILINGUAL, because Canadian carriers require it to be. The CTA's Canadian
 * Common Short Code Compliance Policies (v2.1, January 2026, §3.1) make five keywords
 * mandatory for every program — STOP, ARRET, HELP, AIDE, INFO — "regardless of the
 * intended audience", and texting ARRET or AIDE "must return a French response". DEBUT
 * is here for symmetry rather than obligation: START is the word the STOP acknowledgment
 * offers back, and a French acknowledgment offering an English-only word would be the
 * same broken promise the French half of copy.ts exists to end.
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
 * WHAT TWILIO DOES NOT DO, verified against the platform's own configuration in this
 * repo: `createTwilioTransport` sends with a bare `From` number and no
 * `MessagingServiceSid` (twilio/transport.ts), and localised keywords exist ONLY as
 * explicit entries on a Messaging Service with Advanced Opt-Out configured. Twilio's
 * built-in set is English (STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPTOUT,
 * START/YES/UNSTOP, HELP/INFO). So ARRET, AIDE and DEBUT reach the webhook untouched —
 * nothing intercepts them, nothing double-answers them, and nothing but the revocation
 * this file's `stop` triggers stands between an ARRET and the next send. That last part
 * is the asymmetry worth knowing: an English STOP is additionally caught by Twilio's own
 * opt-out list, a French ARRET is enforced by Hale alone.
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
