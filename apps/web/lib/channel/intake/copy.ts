import { isReferralCode } from '~/lib/channel/referral/code';
import { PRIVACY_URL } from '~/lib/legal-links';

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
 * paraphrased is a promise nobody made. What Hale SOUNDS like on the ACKNOWLEDGMENT
 * turns — the "Got it - …" that echoes a parent's own words back — is model-composed
 * through the `intake-voice` skill, gated on grounding and length, and falling back to
 * the template below whenever the model is unreachable, wrong, or over budget. Every
 * string here is therefore either the message itself or the floor under a composed one.
 *
 * Rule #1: no message ever carries a child's health detail, a precise location, or
 * anything the parent did not just tell us in this conversation.
 */

export interface SourceVenue {
  /** How the venue is named back to the parent. */
  name: string;
  /** The venue's OWN coarse area (FSA). This is a fact about where the poster hangs,
   * not a claim about where the family lives — it seeds discovery when the parent was
   * never asked for a postal code (rule #1: coarse only, never an address). */
  areaCoarse: string;
}

/**
 * The QR venue codes a prefilled body may carry. The registry IS the source of truth:
 * an unrecognised code is treated as no context at all rather than echoed, so Hale can
 * never claim to know a place we have never heard of, nor infer an area from one.
 */
export const SOURCE_VENUES: Record<string, SourceVenue> = {
  LIBRARY: { name: 'library', areaCoarse: 'M5V' },
  REC: { name: 'rec centre', areaCoarse: 'M6K' },
  CLINIC: { name: 'clinic', areaCoarse: 'M4K' },
  SCHOOL: { name: 'school', areaCoarse: 'L7G' },
  'earlyon-richmondhill': { name: 'EarlyON centre', areaCoarse: 'L4C' },
};

/**
 * The prefilled-body conventions. Two forms, both venue-in-the-message (one number,
 * many posters — the venue rides IN the first text rather than in a per-venue phone
 * number or a link the parent would have to open):
 *   1. `HALE <CODE>` — the whole body is the tag (original QR cards).
 *   2. `Hi (via <code>)` — the /text entry page's convention (VIL-240): a human first
 *      message with the tag as a trailing, visibly-disclosed suffix. Suffix-anchored so
 *      an ordinary sentence containing "(via …)" mid-message never matches.
 *
 * A `<code>` is either a QR VENUE (the registry below) or a per-family REFERRAL tag
 * (`friend-…`, lib/channel/referral/code.ts) forwarded by a parent. Both ride the same
 * `?s=` funnel and the same suffix; they differ only in what they resolve to, which is
 * `resolveCode`'s job.
 */
const SOURCE_TAG = /^hale[\s:-]+([a-z0-9-]{2,48})$/i;
const SOURCE_TAG_SUFFIX = /\(via\s+([a-z0-9]+(?:-[a-z0-9]+)*)\)$/i;

/**
 * The canonical registry key for a raw tag, matched case-insensitively.
 *
 * A REFERRAL tag is recognised by its shape rather than by the registry. The registry
 * exists because a venue's NAME is read back to the parent in the greeting, so an
 * unrecognised venue would have Hale claiming to know a place it has never heard of. A
 * referral tag is echoed nowhere and selects nothing — `venueForCode` returns null for
 * it, so the arrival gets the ordinary no-venue greeting and is still asked for a postal
 * code, which is correct: a friend of a Toronto family may live anywhere.
 */
function resolveCode(raw: string): string | null {
  if (isReferralCode(raw)) return raw.toLowerCase();
  if (raw in SOURCE_VENUES) return raw;
  const upper = raw.toUpperCase();
  if (upper in SOURCE_VENUES) return upper;
  const lower = raw.toLowerCase();
  if (lower in SOURCE_VENUES) return lower;
  return null;
}

/** The venue CODE (registry key) for a prefilled first body, or null when the body
 * carries no tag or a tag we don't recognise. */
export function sourceCodeFromBody(body: string): string | null {
  const trimmed = body.trim();
  const full = SOURCE_TAG.exec(trimmed);
  if (full) return resolveCode(full[1] as string);
  const suffix = SOURCE_TAG_SUFFIX.exec(trimmed);
  if (suffix) return resolveCode(suffix[1] as string);
  return null;
}

/** The registry entry for a stored source code, or null. */
export function venueForCode(code: string | null): SourceVenue | null {
  if (!code) return null;
  return SOURCE_VENUES[code] ?? null;
}

/**
 * The first thing a stranger ever reads from Hale.
 *
 * The AI disclosure is IN the introduction rather than trailing it: "an AI that quietly
 * runs the family week" is both what Hale is and what it does, so honesty costs no extra
 * sentence and cannot be skimmed past the way a closing parenthetical can. The privacy
 * link is deliberately NOT here — it rides on {@link WATCH_OFFER}, the one turn where a
 * parent is actually asked to agree to something.
 */
export function greeting(venue: string | null): string {
  if (venue) {
    return `Hi, I'm Hale - an AI that quietly runs the family week for parents around here. You found me at the ${venue}, so I already know the area. Kids' names and ages, and I'll get to work.`;
  }
  return `Hi, I'm Hale - an AI that quietly runs the family week. Registration dates, weekend plans, the stuff that slips. ${COLD_START_ASK}`;
}

/**
 * The ONE thing Hale asks a stranger for, extracted from {@link greeting} because a
 * second door onto intake now exists: somebody who CALLS the number is texted an opener
 * by the voice front door (lib/channel/twilio/voice.ts), and their reply lands in this
 * same machine.
 *
 * Shared rather than re-worded on purpose. Two openers asking for the same two facts in
 * two voices is how a product starts sounding like two products — and the reply parser
 * behind both is one extractor, so an ask that drifts is an ask the machine is no longer
 * tuned for.
 */
export const COLD_START_ASK =
  "Tell me your kids' names and ages, plus your postal code - and I'll get to work.";

/**
 * What intake still needs before a family can be set up. Both are hard requirements
 * and for the same reason: Hale will not invent either one. A postal code it cannot
 * place is a compliance boundary (rule #1); an age it was never given would be a
 * fabricated date of birth, which every stage, checkpoint and registration band is
 * computed from afterwards.
 */
export type IntakeGap = 'ages' | 'location';

const GAP_ASK: Record<IntakeGap, string> = {
  ages: 'how old are they',
  location: "what's your postal code",
};

/**
 * The single targeted ASK, at most once per intake — so when two things are outstanding
 * it asks for both in the one message it gets.
 *
 * Split out from {@link followUp} because the composed acknowledgment reuses it verbatim:
 * `intake-voice` writes the "Got it - …" half and is forbidden from writing a question,
 * so this exact sentence is what the shell appends after it. One question, authored once,
 * whichever half of the turn the model wrote.
 */
export function followUpQuestion(missing: readonly IntakeGap[]): string {
  return `Last thing: ${missing.map((gap) => GAP_ASK[gap]).join(', and ')}?`;
}

/** The deterministic follow-up: the plain echo plus the ask. This is what goes out when
 * the composed acknowledgment is unavailable or unusable — so an outage costs a parent
 * warmth, never the question Hale actually needs answered. */
export function followUp(summary: string, missing: readonly IntakeGap[]): string {
  return `Got it - ${summary}. ${followUpQuestion(missing)}`;
}

/**
 * The consent moment, and the one message in intake that carries a link.
 *
 * The privacy URL lives HERE rather than in the greeting because this is the turn where
 * a parent is asked to agree to ongoing watching — "where does my family's data go" is a
 * question about the thing being consented to, and a link in the greeting would be asked
 * to answer it three messages too early. Built from the {@link PRIVACY_URL} constant so a
 * policy move cannot leave a stale URL inside a consent record's own question.
 */
export const WATCH_OFFER = `Want me to keep an eye on all of this for you? (how I handle your family's info: ${PRIVACY_URL})`;

/**
 * The yes. Names the restraint (only when it matters) and keeps the CASL escape hatch
 * visible. Fixed, because both of those are promises and a promise a model paraphrased
 * is a promise nobody made.
 *
 * IT NO LONGER ENDS IN A QUESTION, and that is this turn's one question budget being
 * spent somewhere better. It used to close on "what part of the week wears you out the
 * most?" — an opener whose answer went to the coach. The turn now closes on the identity
 * ask instead (machine.ts appends it), because Hale had no other moment to ask a texting
 * family what to call them: intake writes `users.name = null` and, until this changed,
 * nothing in the SMS product ever filled it in. A nameless parent is one the introduction
 * email cannot greet, which is exactly where the intros handoff was stalling.
 *
 * The two cannot stack. One message asks one question, and an ack carrying both is a
 * parent choosing which to answer — so the opener is the one that gave way: a parent who
 * texts their name back has still started the conversation that outlives intake, and it
 * arrives after the session closes and is handed to the coach exactly as before (the
 * `no_open_conversation` seam in machine.ts / twilio/inbound.ts).
 *
 * The appended ask is COMPOSED and may defer, so this sentence has to be whole on its
 * own — which it is. A deferred ask costs the name, never the acknowledgment.
 */
export const ASSENT_ACK =
  "Done - you're covered. I only text when something actually matters, and STOP always works.";
export const DECLINE_ACK =
  'No problem - text me whenever you like. The dates and finds are here when you want them.';
export const AMBIGUOUS_CLARIFY =
  "Happy either way - should I watch the registration dates at least? That one's easy to miss.";

/**
 * The CASL keyword replies. STOP gets one final confirmation and then silence; HELP
 * (and anything unparseable) gets the same honest capability line, because a parent
 * who typed something we couldn't read needs to know what we CAN do, not an error.
 */
export const STOP_ACK =
  "You're unsubscribed - I won't text you again. Reply START if you ever want me back.";
export const HELP_REPLY =
  "I'm Hale - I keep track of your family's week and text you when something needs doing. Tell me your kids' names and ages and I'll take it from there. Reply STOP to unsubscribe.";
export const START_ACK = "You're back - I'll text you when something needs doing.";

/**
 * Said ONCE when the one follow-up went unanswered and something Hale cannot invent is
 * still outstanding. It states the blocker plainly and then goes quiet rather than
 * asking a third time — the session stays open, so an answer sent later still completes
 * the setup.
 */
export function detailsBlocked(missing: readonly IntakeGap[]): string {
  if (missing.includes('ages')) {
    return missing.includes('location')
      ? "I can't set your family up until I know your kids' ages and your postal code - send them whenever you're ready."
      : "I can't set your family up until I know how old your kids are - send their ages whenever you're ready.";
  }
  return "I can't set your family up until I know your postal code - send it whenever you're ready.";
}

/** The honest close when a postal code is outside the region Hale is cleared for
 * (rule #1). Nothing is provisioned; the reply says so rather than leaving a family
 * believing they are signed up. */
export const REGION_UNAVAILABLE_REPLY =
  "I'm only set up for families in Canada right now, so I can't help yet - I haven't set anything up.";
