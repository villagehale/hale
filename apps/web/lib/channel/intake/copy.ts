import {
  SOURCE_VENUES,
  type SourceVenue,
  resolveSourceCode,
  sourceCodeFromViaTag,
} from '@hale/source-codes';

/**
 * VIL-237 · M2 — every word Hale texts during intake, in one file.
 *
 * This is the SPEC, not a template layer: the eval suites and the state-machine
 * tests assert against these exact strings, so a copy change is a deliberate,
 * reviewable diff rather than a silent drift in what a stranger's first contact with
 * Hale sounds like.
 *
 * The split is DECISIONS vs RENDERING (the charisma/intelligence split). What Hale
 * DECIDES — which turn comes next, what it will not invent, what a consent record says —
 * is deterministic here, and so is every compliance string (the keyword replies, the
 * blocked and region lines, the consent ask): those are promises, and a promise a model
 * paraphrased is a promise nobody made. #868 moved every onboarding turn to the
 * friend voice (model-written); the fixed follow-up, watch, assent, connector-offer,
 * identity and cold-start lines that used to live here are gone.
 *
 * Rule #1: no message ever carries a child's health detail, a precise location, or
 * anything the parent did not just tell us in this conversation.
 *
 * IT NOW HAS A FRENCH HALF. Hale already replied in French wherever a MODEL wrote the
 * words; everything in this file was English, so a francophone parent got the composed
 * turns in their language and every promise — the introduction, the consent ask, the
 * acknowledgment, the region boundary — in someone else's. The French twin of each fixed
 * line sits beside it in a `Record<CopyLanguage, string>` whose `en` half IS the
 * exported constant, so an English copy edit cannot be half-applied, and `replyLanguage`
 * (lib/channel/language.ts) picks between them from the message that just arrived.
 *
 * THE FRENCH IS GSM-7, which is a constraint on the WORDS and not a fold applied after
 * them. The alphabet carries é è à ù and not â ê î ô û ç, so the copy below is written
 * around the characters it cannot have — and where the language leaves no way around one
 * (`age`, which has no accent-free synonym in this register), the circumflex is dropped
 * to its base letter exactly as `gsmSafe` folds a family's own name. Each such word is
 * named at its constant. The alternative is a UCS-2 message at 70 characters a segment:
 * triple the carrier bill on Hale's first sentence to a stranger, forever.
 */

// The venue registry lives in @hale/source-codes so the site validates `?s=` codes
// against the SAME list this intake resolves. Re-exported for existing importers.
export { SOURCE_VENUES, type SourceVenue };

/**
 * The prefilled-body conventions. Two forms, both venue-in-the-message (one number,
 * many posters — the venue rides IN the first text rather than in a per-venue phone
 * number or a link the parent would have to open):
 *   1. `HALE <CODE>` — the whole body is the tag (original QR cards).
 *   2. `Hi (via <code>)` — the /text entry page's convention (VIL-240): a human first
 *      message carrying the tag. Matched ANYWHERE in the body (a parent may type after
 *      the prefilled tag); the tag must close right after the code, so "(via the
 *      highway)" never matches.
 *
 * A `<code>` is a QR VENUE (the shared registry), a per-family REFERRAL tag
 * (`friend-…`) or a co-parent JOIN tag (`join-…`). Resolution — shapes for the last
 * two, registry membership for venues — is `resolveSourceCode` in @hale/source-codes,
 * the same function the site uses to decide what it pre-fills. An unregistered venue
 * still resolves to null here: Hale never claims to know a place it has never heard of.
 */
const SOURCE_TAG = /^hale[\s:-]+([a-z0-9-]{2,48})$/i;

/** The canonical code for a prefilled first body, or null when the body carries no tag
 * or a tag we don't recognise. */
export function sourceCodeFromBody(body: string): string | null {
  const trimmed = body.trim();
  const full = SOURCE_TAG.exec(trimmed);
  if (full) return resolveSourceCode(full[1] as string);
  return sourceCodeFromViaTag(trimmed);
}

/** The registry entry for a stored source code, or null. */
export function venueForCode(code: string | null): SourceVenue | null {
  if (!code) return null;
  return SOURCE_VENUES[code] ?? null;
}

/** The PLACE a stored source code's poster hangs in, or null when the code is not one of
 * the founder's own posters. The whole trigger for the founder-welcome ping — see
 * {@link SourceVenue.poster}. */
export function posterLocation(code: string | null): string | null {
  return venueForCode(code)?.poster ?? null;
}

/**
 * What intake still needs before a family can be set up. Both are hard requirements
 * and for the same reason: Hale will not invent either one. A postal code it cannot
 * place is a compliance boundary (rule #1); an age it was never given would be a
 * fabricated date of birth, which every stage, checkpoint and registration band is
 * computed from afterwards.
 */
export type IntakeGap = 'ages' | 'location';

/**
 * The calendar card, its own text, after the call-name.
 *
 * One ask: the link. The bubble is short. The link unfurls as its own card
 * (title + the trust line). The kids-year payoff is the text after it connects,
 * not a second ask here. GSM-7.
 */
export const INTAKE_CALENDAR_CARD_TEMPLATE_KEY = 'intake:calendar_card';

/**
 * The Gmail card, its own text, after the calendar card.
 *
 * One ask: the link. Ignoring it is the skip. Same trust line as the calendar
 * card, with this connector's disconnect words. GSM-7.
 */
export const INTAKE_GMAIL_CARD_TEMPLATE_KEY = 'intake:gmail_card';

/**
 * Last ask of intake on SMS, its own text, after the Gmail card.
 *
 * The SMS door still needs a number before it can text the invite, so this door
 * keeps the number ask. Linq does not use it: the iMessage ask is
 * `linqCoParentAsk` (Sloane, 2026-09-25) and does not collect a phone.
 * This ask does not claim an invite already left. "add my partner" still
 * mints a forwardable link when a parent types that phrase later.
 */
export const INTAKE_COPARENT_ASK_TEMPLATE_KEY = 'intake:coparent_ask';
