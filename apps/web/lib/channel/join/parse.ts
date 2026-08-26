/**
 * Reading "add my partner" off a text — the ONE sentence that mints a co-parent link.
 *
 * DELIBERATELY NOT A MODEL, on the same argument `caregiver/parse.ts` makes: this
 * sentence produces a capability that seats somebody in a household with the full family
 * scope. A probabilistic reading of whether the parent meant it is a wrong reading that
 * hands out that capability, and the cost of a miss in the other direction is one turn
 * of ordinary conversation.
 *
 * ANCHORED AT BOTH ENDS, which is the whole of VIL-260's lesson: "add" is the verb
 * parents use about their own calendar far more often than about a person, and a prefix
 * match turns "add my partner's dentist appointment" into an invite. Nothing may follow
 * the phrase.
 *
 * THE POSSESSIVE IS THE SCOPE. "my dad" is the texting parent's own father — a
 * grandparent, whose access is the caregiver flow's scoped slice and not this. "dad"
 * with no possessive is the children's other parent. So the possessive is REQUIRED for
 * the partner words and REFUSED for the parent words, rather than being tolerated on
 * both and resolved by a guess.
 */

/** How a parent names the person who shares the household with them. */
const PARTNER_WORDS = 'partner|spouse|wife|husband|co-parent|coparent|co parent';

/** How a parent names the children's other parent without a possessive. */
const OTHER_PARENT_WORDS = 'dad|mom|mum|father|mother';

const JOIN_REQUEST = new RegExp(
  `^(?:add|invite)\\s+(?:(?:my|our)\\s+(?:${PARTNER_WORDS})|(?:${OTHER_PARENT_WORDS}))\\.?$`,
  'i',
);

/** Whether the parent asked for their co-parent to be added, with no number given. */
export function looksLikeJoinRequest(body: string): boolean {
  return JOIN_REQUEST.test(body.trim());
}
