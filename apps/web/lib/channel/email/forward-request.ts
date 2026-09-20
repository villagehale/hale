import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * ASKING FOR THE FORWARDING ADDRESS, IN THE THREAD — the door that opens the door
 * (VIL-352 rung 3a).
 *
 * `mintForwardToken` and `revokeForwardToken` (forward-address.ts) had no caller outside
 * their own test, which meant the forwarding leg could only ever be reached by hand SQL:
 * a whole rung of the product with no way in. The way in is the thread, because that is
 * where this product lives — a parent asks for their address the way they ask for a
 * calendar link, and Hale answers with the real thing rather than a sentence about one.
 *
 * WHY THIS MATCHER IS NOUN-ANCHORED WHERE connect/detect.ts IS VERB-ANCHORED, and what
 * that costs. That matcher needs a connect VERB in front of its noun because "calendar"
 * is a word a family uses ten times a week about the thing on the fridge, so a bare noun
 * is usually about its CONTENTS. "Forwarding address" is rare enough that "what's my
 * forwarding address", with no verb at all, is how every parent will actually ask, and
 * has to be claimed. But the phrase is NOT one this product owns, and the first cut of
 * this matcher assumed it was: Canada Post forwards mail, a camp has a forwarding
 * address, and "stop forwarding" is an ordinary sentence about an ordinary inbox. Reading
 * the bare word `forwarding` as a turn-off instruction made five natural sentences revoke
 * a live credential.
 *
 * So the noun is evidence only when all three of these hold, and each is its own
 * subtraction below — the discipline connect/detect.ts's disconnect half already keeps:
 *
 *  - THE WHOLE NOUN, never the bare word: "forwarding address" / "adresse de transfert",
 *    never `forwarding` or `transfert` alone ({@link ADDRESS_NOUN}, which BOTH halves now
 *    read). That word belongs to the daycare's emails and the school portal at least as
 *    often as it belongs to us.
 *  - THE TEXTER'S OWN: a third-person possessive in front of the noun makes it somebody
 *    else's — "email the forms to THEIR forwarding address" ({@link SOMEBODY_ELSES}).
 *  - THE ASK ENDS THERE: a sentence that keeps going past the noun is ABOUT the address,
 *    not a request for one — "my forwarding address FOR MAIL is changing next month"
 *    ({@link ENDS_THE_ASK}).
 *
 * Each subtraction costs some honest ask one coach turn, and buys back a write or a
 * revoke that nobody asked for. That is the direction this matcher always errs in.
 *
 * The two halves below are disjoint BY CONSTRUCTION, the same way the connector pair is:
 * every verb the turn-off half reads is inside the asking half's {@link NEGATION} class,
 * so no body can be claimed by both and their order can never matter.
 *
 * IT READS NO BARE WORD. Both halves require the whole noun, so this handler can never
 * claim a YES or a NO that belongs to somebody else's open question, and it never
 * consults the open-question list — there is nothing for it to be an answer to.
 */

/** Mail, as a parent names the thing they forward. */
const MAIL = '(?:mail|e-?mails?|courriels?)';

/**
 * The noun, in the shapes a parent writes it. `transfert` and `renvoi` are the two French
 * words Canadian mail clients use for forwarding; `faire suivre` is what a person says.
 */
const ADDRESS_NOUN = [
  `forward(?:ing)?\\s+(?:${MAIL}\\s+)?address`,
  `${MAIL}\\s+forwarding\\s+address`,
  'adresse\\s+de\\s+(?:transfert|renvoi)',
  'adresse\\s+pour\\s+(?:transf[ée]rer|faire\\s+suivre)',
].join('|');

/**
 * NOT THIS PARENT'S ADDRESS. A third-person possessive in front of the noun hands it to
 * somebody else — "the camp said to email the forms to THEIR forwarding address", "the
 * camp's forwarding address is different from ours" — and the only address this handler
 * can answer with is the family's own.
 *
 * Tested against the WHOLE BODY rather than written as a lookbehind on the patterns
 * below, because a lookbehind is defeated by one word: in "their EMAIL forwarding
 * address" the noun can still be reached from the right of the possessive. Second person
 * is deliberately absent — in this thread "your forwarding address" is addressed to Hale,
 * and Hale's is the one being asked for.
 */
const SOMEBODY_ELSES = new RegExp(
  `(?:\\b(?:their|his|her|its|leur|leurs|son|sa|ses)|['’]s)\\s+(?:${MAIL}\\s+)?(?:${ADDRESS_NOUN})\\b`,
  'i',
);

/**
 * THE ASK ENDS AT THE NOUN — an allow-list, not a list of banned tails, because the tails
 * that mean "this sentence is about an address" are open-ended ("for mail", "on the
 * school portal", "of the newsletter", "de la garderie") while the words that may follow
 * a real ask are a closed handful.
 *
 * A request stops at the credential and is then punctuated, or trails off with one of the
 * politeness words a parent adds. Anything else is a clause, and a clause means the
 * address is the subject of a sentence rather than the object of an ask.
 */
const ENDS_THE_ASK = String.raw`(?=\s*(?:[.,;:!?)]|$)|\s+(?:again|please|pls|svp|encore)\b)`;

const ADDRESS_PATTERN = new RegExp(`\\b(?:${ADDRESS_NOUN})\\b${ENDS_THE_ASK}`, 'i');

/**
 * The other way a parent asks for the same thing, without ever naming the noun: "what
 * email do I forward to". Spelled out as its own pattern rather than loosened into the
 * one above, because every word of it is load-bearing — "forward this to my husband" and
 * "I forwarded you the school email" must both fall through to the coach.
 */
const WHERE_DO_I_FORWARD = new RegExp(
  `\\b(?:what|which|where)(?:'?s)?\\s+(?:${MAIL}|address)?\\s*(?:do|can|should|may)?\\s*(?:i|we)\\s+forward\\s+(?:${MAIL}\\s+)?to\\b${ENDS_THE_ASK}`,
  'i',
);

/**
 * The turn-off verbs. Every one is also in {@link NEGATION}, which is what makes the two
 * halves disjoint without anyone having to read them together.
 */
const TURN_OFF_VERB =
  '(?:turn(?:ing)?\\s+off|shut(?:ting)?\\s+(?:off|down)|switch(?:ing)?\\s+off|disable|deactivate|revoke|delete|cancel|stop|d[ée]sactive[rz]?|d[ée]sactiver|supprime[rz]?|annule[rz]?|arr[êe]te[rz]?)';

/**
 * A negation, or an instruction to END the thing, means this is not a request FOR the
 * address. Both directions in one class: "don't give me a forwarding address" and "turn
 * off my forwarding address" are each a reason the asking half must decline, and folding
 * them together is what guarantees the two halves cannot both claim a body. The
 * apostrophe class carries U+2019, because iPhones send smart punctuation.
 */
const NEGATION = new RegExp(
  `\\b(?:don['’]?t|do not|never|ne\\s+pas|jamais|${TURN_OFF_VERB})\\b`,
  'i',
);

/** "don't turn off my forwarding address" is the opposite instruction, and it must not
 * revoke a credential. Separate from {@link NEGATION}, which holds the turn-off verbs
 * themselves. */
const TURN_OFF_NEGATION = /\b(?:don['’]?t|do not|never|ne\s+pas|jamais)\b/i;

/**
 * THE WHOLE NOUN HERE TOO, and this line is the blocker VIL-352 round 4 found.
 *
 * The alternation used to end `|forwarding|transferts?`, so an explicit turn-off verb in
 * front of the bare word was enough to delete a live token: "can you stop forwarding me
 * these emails from the daycare", "should I turn off forwarding on the school portal",
 * "I need to delete the forwarding rule in gmail". Every one of those is a sentence about
 * somebody else's inbox, and every one of them revoked. The asking half was already
 * anchored on the full noun; this half simply was not, and the doc above claimed
 * otherwise.
 *
 * The price is that "turn off forwarding" — an honest instruction — now costs one coach
 * turn. That is the right side to be wrong on when the other side is a destroyed
 * credential, and it is the same call connect/detect.ts's disconnect half makes.
 */
const TURN_OFF_PATTERN = new RegExp(
  `\\b${TURN_OFF_VERB}(?:\\s+(?:my|our|the|mon|ma|notre|le|la|les))?\\s+(?:${ADDRESS_NOUN})\\b${ENDS_THE_ASK}`,
  'i',
);

/** What a parent plainly asked about their forwarding address, or null — and null is the
 * safe answer, because null costs one coach turn while a wrong claim either hands out a
 * credential nobody asked for or takes one away. */
export type ForwardAddressAsk = 'address' | 'turn_off';

export function matchForwardAddressRequest(body: string): ForwardAddressAsk | null {
  if (SOMEBODY_ELSES.test(body)) return null;
  if (!TURN_OFF_NEGATION.test(body) && TURN_OFF_PATTERN.test(body)) return 'turn_off';
  if (NEGATION.test(body)) return null;
  return ADDRESS_PATTERN.test(body) || WHERE_DO_I_FORWARD.test(body) ? 'address' : null;
}

/**
 * WHAT HALE SAYS BACK, and what it is careful not to promise.
 *
 * Locked copy: straight quotes and hyphens, GSM-7 throughout including the French twin
 * (é è à ù yes; â ê î ô û ç no), and an FR twin for every line. Held by the RENDERED
 * assertions in sms-copy-encoding.test.ts rather than by that suite's whole-file scan —
 * the connect pair's split, for its reason: a matcher has to carry the smart apostrophe
 * an iPhone sends, so the file cannot pass a source scan, and the table below is small
 * enough that the rendered check is exhaustive over it anyway.
 *
 * TWO SEGMENTS for the address, ONE for each receipt, and the split is the honest one:
 * the address alone is 56 characters, and the sentence that goes with it has to say the
 * consent rule — that an unknown sender is ASKED about, not read — or the parent sets up
 * a filter believing Hale is already reading their mail. A message that hands over a
 * credential is the wrong place to save a segment. The receipts have no address in them
 * and fit in one.
 *
 * THE RECEIPT NEVER OVERCLAIMS. Revoking nulls the token, so mail sent to the old address
 * resolves no family and is dropped — it is not bounced, and Hale does not say it is.
 */
const ADDRESS_BY_LANGUAGE: Record<ReplyLanguage, (address: string) => string> = {
  en: (address) =>
    `Forward mail to ${address} and I'll read it. From a sender you haven't okayed, I ask you first - nothing is read until you say yes. Tell me any time to turn the address off.`,
  fr: (address) =>
    `Transférez votre courrier à ${address} et je le lirai. D'un expéditeur que vous n'avez pas approuvé, je vous demande d'abord - rien n'est lu avant votre oui. Dites-moi quand vous voulez pour désactiver l'adresse.`,
};

/** The whole reply, address included — composed here and nowhere else, so the sentence
 * and the credential cannot be split by any later fitting. */
export function forwardAddressReply(language: ReplyLanguage, address: string): string {
  return ADDRESS_BY_LANGUAGE[language](address);
}

/** Whether there was a live address to turn off. `not_configured` is never dressed up as
 * a success: nothing of theirs was revoked, and the reply says so (rule #11). */
export type ForwardRevokeOutcome = 'revoked' | 'not_configured';

const REVOKE_BY_LANGUAGE: Record<ReplyLanguage, Record<ForwardRevokeOutcome, string>> = {
  en: {
    revoked:
      'Done - your forwarding address is off. Mail sent to it from now on is ignored. Text forwarding address if you ever want a new one.',
    not_configured: `You don't have a forwarding address set up, so there is nothing to turn off. Text forwarding address if you want one.`,
  },
  fr: {
    revoked:
      'Fait - votre adresse de transfert est désactivée. Le courrier qui y arrive est ignoré. Textez adresse de transfert si vous en voulez une autre.',
    not_configured: `Vous n'avez pas d'adresse de transfert, il n'y a donc rien à désactiver. Textez adresse de transfert si vous en voulez une.`,
  },
};

export function forwardRevokeReply(language: ReplyLanguage, outcome: ForwardRevokeOutcome): string {
  return REVOKE_BY_LANGUAGE[language][outcome];
}
