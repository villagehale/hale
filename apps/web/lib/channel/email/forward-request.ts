import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
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
 * AND THEN A FOURTH, WHICH IS NOT A SUBTRACTION FROM THE NOUN BUT A REQUIREMENT ON THE
 * SENTENCE: an ask has an ASK SHAPE ({@link asksForOne}). The three guards above all
 * ask what the NOUN is doing, and a declarative clears every one of them — "I already set
 * up a canada post forwarding address.", "the school has a new forwarding address." both
 * end at the noun, own it in the first person or no person, and each one MINTED a token
 * and handed a parent a credential in answer to a sentence that was telling Hale
 * something. A request is a question, an imperative addressed to Hale, or the bare noun
 * on its own; a statement is none of those.
 *
 * THE TWO HALVES ARE NOT SYMMETRICAL ANY MORE, and that is round 6 (D17). The asking half
 * still ACTS — it mints and hands over an address, which a parent can simply ignore. The
 * turn-off half no longer does: it opens a confirm question ({@link forwardRevokeAskReply})
 * and the revoke happens only when that question is answered yes. Revoking is
 * hard-to-reverse — a new token is a DIFFERENT address the parent has to go and re-enter
 * in their mail filter — and D17's rule for hard-to-reverse is an unambiguous go.
 *
 * WHICH IS WHY THE HYPOTHETICALS ARE NO LONGER THIS MATCHER'S PROBLEM. Rounds 4 and 5 each
 * closed one named false positive and each time the next reader found another in the same
 * class: "what happens if I turn off my forwarding address?", "should I turn off my
 * forwarding address?", "I didn't turn off my forwarding address, did the emails stop?".
 * A regex over natural language cannot be closed against that, and every attempt bought
 * one more tail rule. Under the confirm turn all of them cost exactly one text nobody has
 * to answer, so the matcher is allowed to be generous about them — while the noun anchor
 * and the third-party guard, which keep somebody ELSE'S forwarding out of this lane
 * entirely, stay exactly as they are.
 *
 * The two halves are still disjoint BY CONSTRUCTION, the same way the connector pair is:
 * every verb the turn-off half reads is inside the asking half's {@link NEGATION} class,
 * so no body can be claimed by both and their order can never matter.
 *
 * IT READS NO BARE WORD. Both halves require the whole noun, so a YES or a NO can never
 * be claimed by the MATCHER. The handler does read a bare affirmative now — but only as
 * the answer to the confirm question above, and only when nothing else at all is open
 * (handlers.ts `forwardAddressHandler`).
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

/** What a parent opens with before they get to the ask. Stripped so a greeting cannot
 * hide the interrogative behind it — "bonjour, quelle est mon adresse de transfert". */
const GREETING = String.raw`(?:h(?:i|ello|ey|iya)|good\s+(?:morning|afternoon|evening)|bonjour|salut|allo|coucou|ok(?:ay)?|hale)\b[\s,!.:-]*`;

/**
 * A QUESTION, at the start of the message or of a clause inside it.
 *
 * Clause-start rather than anywhere, because a wh-word loose in a sentence is usually
 * subordinate ("I set up a filter so I know WHERE the mail goes"), and clause-start
 * rather than message-start only, because a greeting and a comma are how half of these
 * arrive. `what(?:'s)?` spells its own contraction: "whats" is one word to `\b`.
 */
const INTERROGATIVE_LEAD = new RegExp(
  `(?:^|[.,;:!?]\\s*)(?:${GREETING})?(?:what(?:['’]?s)?|which|where|how|can|could|do|may|quel(?:le)?s?|o[uù]|comment|est-ce|avez|pouvez|peux|puis)\\b`,
  'i',
);

/**
 * AN IMPERATIVE ADDRESSED TO HALE, AND IT HAS TO OPEN A CLAUSE.
 *
 * `send|text|give|share|resend` only with an object pronoun after them, because "forward
 * the invite to grandma" is an instruction about somebody else's mail and this lane must
 * never read one. `forward` is deliberately absent from the verb list for the same
 * reason.
 *
 * THE ANCHOR IS ROUND 7's BLOCKER. Tested anywhere in the body, a verb and a pronoun are
 * not an imperative — they are a two-word substring, and the subject in front of them is
 * the whole difference between an instruction and news. "the school will send us a
 * forwarding address.", "Canada Post will give us a forwarding address." and "the camp
 * said they'd text me the forwarding address." each minted a token and texted a parent
 * their own credential in answer to a sentence about somebody else. An imperative has no
 * subject: it opens the message, or it opens a clause inside it — the same anchor
 * {@link INTERROGATIVE_LEAD} uses, for the same reason. `please` and the `can you` frame
 * live INSIDE the anchor because they are what a parent puts between the clause start and
 * the verb, and nothing else may stand there.
 */
const ASK_VERB = new RegExp(
  `(?:^|[.,;:!?]\\s*)(?:${GREETING})?(?:please\\s+|(?:can|could|will|would)\\s+you\\s+(?:please\\s+)?)?(?:(?:send|text|give|share|resend)\\s+(?:me|us)|(?:envoyez?|donnez?)[-\\s]moi)\\b`,
  'i',
);

/**
 * THE WANT WHOSE OBJECT IS THE ADDRESS ITSELF, and no other want.
 *
 * "I want" and "I need" used to be evidence on their own, which made every sentence that
 * merely CONTAINED one a request: "I need to give the daycare my forwarding address." and
 * "I want to keep my forwarding address." both minted. The noun has to come directly
 * after the verb, with nothing but a determiner between them, because anything else in
 * that gap is a second verb — and the address is then ITS object, not the thing being
 * asked for.
 *
 * A parent who wants theirs writes "I want my forwarding address" and gets it. A parent
 * whose sentence falls through here reaches the coach, and the address reply's own
 * closing line is what taught them the words that do work.
 */
const WANT_VERB = String.raw`(?:(?:i|we)\s+(?:want|need)|je\s+veux|j['’]?ai\s+besoin\s+d[e'’]?)`;
const WANT_DETERMINER = String.raw`(?:(?:my|our|the|a|mon|ma|notre|le|la|une?)\s+|l['’]\s*)`;

const WANT_ONE = new RegExp(`\\b${WANT_VERB}\\s*${WANT_DETERMINER}(?:${ADDRESS_NOUN})\\b`, 'i');

/** The whole message IS the noun — "forwarding address", the way a parent who has been
 * told to text it writes it. A determiner and one politeness word are allowed; anything
 * else makes it a sentence, and a sentence has to be shaped like an ask. */
const BARE_NOUN_ONLY = new RegExp(
  `^\\s*(?:${GREETING})?(?:(?:my|our|the|mon|ma|notre|le|la|les)\\s+)?(?:${ADDRESS_NOUN})\\s*[.!?]*\\s*(?:(?:again|please|pls|svp|encore)\\s*[.!?]*\\s*)?$`,
  'i',
);

/**
 * IS THIS SENTENCE ASKING FOR ONE — the guard that stops a statement minting a credential.
 *
 * Five shapes, and a declarative is none of them. The residual cost is honest: "Do you
 * know if the school has a new forwarding address?" is a question about somebody else's
 * address that no possessive marks, and it still mints. That is one address handed to the
 * family it belongs to, which the reply then explains — the cheap side of this matcher's
 * standing trade, and the same side every other guard here errs on.
 */
function asksForOne(body: string): boolean {
  return (
    INTERROGATIVE_LEAD.test(body) ||
    ASK_VERB.test(body) ||
    WANT_ONE.test(body) ||
    BARE_NOUN_ONLY.test(body) ||
    /\?\s*$/.test(body)
  );
}

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
  `\\b${TURN_OFF_VERB}(?:\\s+(?:my|our|your|the|mon|ma|notre|votre|le|la|les))?\\s+(?:${ADDRESS_NOUN})\\b${ENDS_THE_ASK}`,
  'i',
);

/**
 * What a parent plainly said about their forwarding address, or null.
 *
 * `turn_off` MEANS "ASKED ABOUT TURNING IT OFF", not "turn it off" — the confirm turn is
 * what the handler does with it. Null is still the safe answer: it costs one coach turn,
 * while a wrong `address` hands out a credential nobody asked for.
 */
export type ForwardAddressAsk = 'address' | 'turn_off';

export function matchForwardAddressRequest(body: string): ForwardAddressAsk | null {
  if (SOMEBODY_ELSES.test(body)) return null;
  if (!TURN_OFF_NEGATION.test(body) && TURN_OFF_PATTERN.test(body)) return 'turn_off';
  if (NEGATION.test(body)) return null;
  // WHERE_DO_I_FORWARD is interrogative by construction — every word of it is a question
  // word — so it carries its own ask shape and is not asked for one twice.
  if (WHERE_DO_I_FORWARD.test(body)) return 'address';
  return ADDRESS_PATTERN.test(body) && asksForOne(body) ? 'address' : null;
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
/**
 * THE CLOSING LINE QUOTES THE COMMAND, and the command goes LAST.
 *
 * It used to read "Tell me any time to turn the address off." — a sentence neither half
 * of the matcher above reads, so a parent doing exactly what Hale told them to do reached
 * the coach. A reply that teaches words has to teach words that work. The command sits at
 * the end of the line so that a parent who copies the whole line back still lands on it:
 * {@link ENDS_THE_ASK} is satisfied by the full stop, and by nothing that would follow.
 */
const ADDRESS_BY_LANGUAGE: Record<ReplyLanguage, (address: string) => string> = {
  en: (address) =>
    `Forward mail to ${address} and I'll read it. From a sender you haven't okayed, I ask you first - nothing is read until you say yes. Any time, text turn off my forwarding address.`,
  fr: (address) =>
    `Transférez votre courrier à ${address} et je le lirai. D'un expéditeur que vous n'avez pas approuvé, je vous demande d'abord - rien n'est lu avant votre oui. Quand vous voulez, textez désactiver mon adresse de transfert.`,
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

/**
 * THE CONFIRM ASK — the whole of round 6 in one sentence (D17).
 *
 * It says the COST before it asks for the go, because that is the half a parent cannot
 * work out for themselves: nulling the token does not bounce anything, it makes mail sent
 * to the old address resolve no family and stop. It prints "Reply YES" verbatim, which is
 * why this kind is `solicited` on the open-question list — and it offers SILENCE as the
 * other answer rather than a keyword, because the safe outcome must be the free one.
 *
 * It promises nothing in the past tense. A question that reads like a receipt is the
 * failure this replaces.
 */
const REVOKE_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Turn off your forwarding address? Mail sent to it would be ignored from then on. Reply YES to turn it off, or ignore this.',
  fr: 'Désactiver votre adresse de transfert? Le courrier qui y arrive serait ignoré. Répondez OUI pour la désactiver, ou ignorez ce message.',
};

export function forwardRevokeAskReply(language: ReplyLanguage): string {
  return REVOKE_ASK_BY_LANGUAGE[language];
}

/**
 * THE NO, ANSWERED — and it is answered rather than passed over for a reason that is not
 * manners.
 *
 * The confirm question is derived from the message ledger, and what closes it is one of
 * its own two receipts (see {@link forwardRevokeAsk}). A NO that produced no outbound
 * would leave the question STANDING for the rest of its window, so the parent's next
 * unrelated "yeah, sounds good" would land on a revoke they had just declined. Saying
 * this one sentence, under its own template key, is what closes it.
 */
const REVOKE_DECLINED_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Okay - your forwarding address is still on.',
  fr: 'Entendu - votre adresse de transfert reste active.',
};

export function forwardRevokeDeclinedReply(language: ReplyLanguage): string {
  return REVOKE_DECLINED_BY_LANGUAGE[language];
}

// ── the confirm question, derived from the ledger ────────────────────────────

/** The name the ask's own outbound row carries, so the reader below can recognise Hale's
 * own voice later. Without it there is no question, and a YES goes nowhere. */
export const FORWARD_REVOKE_ASK_TEMPLATE_KEY = 'forward_address:revoke_ask';

/**
 * THE TWO RECEIPTS, NAMED — because the ledger has to be able to see that the question was
 * ANSWERED, which is a different fact from Hale having spoken.
 *
 * Round 6 derived both from the same fact: the question stood while its ask was Hale's
 * last word, so the receipt closed it by being newer. That conflated "answered" with
 * "spoke since", and Hale's own clarifying turn — a sentence whose entire subject is this
 * question — closed it as thoroughly as the answer would have. These two names are what
 * let the two be told apart with no row and no column added.
 */
export const FORWARD_REVOKE_TEMPLATE_KEY = 'forward_address:revoked';
export const FORWARD_REVOKE_DECLINED_TEMPLATE_KEY = 'forward_address:revoke_declined';

/**
 * How long the confirm stands. FIFTEEN MINUTES — the connector sign-in link's window
 * (connect/offer.ts), and for its reason: it is the span in which "the thing Hale just
 * asked me" is still one identifiable thing. Long enough for a parent to put the kettle
 * on, short enough that a YES typed hours later, at whatever Hale has said since, cannot
 * reach back and delete a credential.
 */
export const FORWARD_REVOKE_ASK_TTL_MS = 15 * 60 * 1000;

/**
 * THE CONFIRM THIS PARENT HAS NOT ANSWERED, or null — the ask itself, read off the ledger.
 *
 * NO ROW AND NO COLUMN BEHIND IT, the evening check-in's and the registration ladder's
 * pattern (checkin/reply.ts, registration/sequence/prepare-reply.ts), for their reason:
 * both facts are already in `channel_messages`. When the ask went out is the row's own
 * `created_at`; whether it has been answered is whether one of its two receipts has gone
 * out since. A stored `pending` flag would be a second answer to that, and every other
 * sender in the product would have to remember to clear it.
 *
 * TWO CONDITIONS, AND THE SECOND ONE IS ROUND 7. It stands while it is inside its window
 * and while NEITHER RECEIPT has followed it. Round 6 closed it on any newer outbound
 * instead, which is a rule about who spoke rather than about what was answered — and the
 * message it closed the question with was, in the case the round-6 verifier found, Hale's
 * own clarifying menu ASKING WHICH QUESTION THE PARENT MEANT. Hale offered the revoke on
 * that menu, the parent picked it, and the pick answered a question that had stopped
 * existing the moment the menu was sent. Answering is what ends a question; saying
 * something else is not.
 *
 * The last-word rule did not go away, it MOVED — to the bare-word door, which is the only
 * place it was ever doing work (handlers.ts `forwardAddressHandler`). A word with no
 * target in it can only mean the last thing that was said; a reading that names its
 * question does not need to be the last thing at all.
 *
 * BY ID, when the caller has one. `askMessageId` is the resolved answer's `questionId` —
 * the ask's own row — so the door that acts on a model's or a menu's reading acts on the
 * question that reading actually named, never on whatever the newest ask happens to be.
 *
 * PER PARENT, like the intro opt-in and the co-parent scope question: the confirm went to
 * one phone, and a co-parent who never saw it must not be able to spend it.
 *
 * SENT_STATUSES rather than the dedupe set, for the reason the check-in reader gives: a
 * send that failed never reached the phone, and a question nobody was asked is not open.
 */
export async function forwardRevokeAsk(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date; askMessageId?: string },
): Promise<{ id: string; askedAt: Date } | null> {
  const [ask] = await database
    .select({ id: schema.channelMessages.id, createdAt: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.templateKey, FORWARD_REVOKE_ASK_TEMPLATE_KEY),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(
          schema.channelMessages.createdAt,
          new Date(input.now.getTime() - FORWARD_REVOKE_ASK_TTL_MS),
        ),
        ...(input.askMessageId ? [eq(schema.channelMessages.id, input.askMessageId)] : []),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;

  const [receipt] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.templateKey, [
          FORWARD_REVOKE_TEMPLATE_KEY,
          FORWARD_REVOKE_DECLINED_TEMPLATE_KEY,
        ]),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, ask.createdAt),
      ),
    )
    .limit(1);
  return receipt ? null : { id: ask.id, askedAt: ask.createdAt };
}

/**
 * HAS HALE SAID ANYTHING TO THIS PARENT SINCE — the last-word rule, on its own, for the
 * one door that needs it.
 *
 * A bare YES carries no target, so the only question it can possibly be answering is the
 * one Hale asked last. Anything Hale has said since — a coach turn, a nudge, its own
 * clarifying menu — makes the word ambiguous in a way no reader can fix, and this lane
 * would be spending a credential on the guess. The resolved door does not consult it,
 * because a reading that names the question has already said which one it means.
 */
export async function nothingSaidSince(
  database: Database,
  input: { parentUserId: string; askedAt: Date },
): Promise<boolean> {
  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, input.askedAt),
      ),
    )
    .limit(1);
  return newer === undefined;
}

/**
 * Rule #6 for the ASK itself — Hale proposed destroying a credential, and that is a thing
 * the trail has to be able to say.
 *
 * Written from `afterSend`, against the outbound row that carried the question, so an ask
 * the transport refused leaves no record of a question nobody was asked (the MEM-10
 * send-time discipline). The row names no token and no address.
 */
export async function recordForwardRevokeAsked(
  database: Database,
  input: { familyId: string; channelMessageId: string },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'email_forward_address_revoke_asked',
    targetTable: 'channel_messages',
    targetId: input.channelMessageId,
  });
}
