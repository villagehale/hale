import { COLD_START_ASK } from '~/lib/channel/intake/copy';

/**
 * VIL-214 · A3 — the one line A3 owns. Everything else Hale says over SMS belongs to
 * M2's intake copy or M6's caregiver copy; A3 only has to answer the case those two
 * cannot see, a message with no readable text.
 *
 * The voice front door's four lines live here too, for the same reason: they answer a
 * case no other copy module can see — somebody who reached Hale on a channel Hale does
 * not hold a conversation on.
 */

/**
 * MMS, v1. Hale does not fetch Twilio media URLs — that would pull a family's photos
 * (often OF their children) into our infrastructure, which needs its own privacy review
 * and retention story before a single byte moves (rule #1). Until then the honest
 * answer is that we cannot read it.
 *
 * And the ask stays in the thread. "Send it in the app" (skill audit P0 #4) made a
 * parent who photographed a permission form at the door go and re-upload it somewhere
 * else; typing the date and the name is the smaller job, and it is one Hale can act on
 * the moment it arrives.
 */
export function mediaUnsupportedReply(): string {
  return "I can't read attachments over text yet - type me the bit that matters and I'll take it from there.";
}

/**
 * THE VOICE FRONT DOOR, v0 — what a caller hears, and what lands in their thread.
 *
 * Hale is a number you text (F14 · D1). Until now a call to that number hit Twilio's
 * default error recording, which is the worst possible first impression: a product whose
 * whole promise is "I answer" not answering. v0 does not make the call a conversation —
 * it makes the call a LEAD, spoken in nine seconds and handed to the channel Hale
 * actually works on.
 *
 * Both spoken lines are short on purpose. A caller has the phone to their ear and no way
 * to scroll back, so anything they need is repeated in the text they are about to read.
 */

/** Spoken when a text is in their thread. */
export const VOICE_GREETING =
  "Hi, this is Hale. I work by text - I've just sent you a message so we can get started. Talk soon.";

/**
 * Spoken when no text is going out: the caller unsubscribed, the number is unreadable, or
 * the send failed. It stops at what is true rather than promising a message that is not
 * coming — and for the unsubscribed caller it is deliberately a dead end, with no
 * invitation back. They said STOP; a voice prompt talking them out of it is the same
 * re-solicitation in a different channel (rule #1 / CASL).
 */
export const VOICE_GREETING_NO_TEXT = 'Hi, this is Hale. I work by text.';

/**
 * The text a STRANGER gets after calling. It is the cold-start greeting's job done
 * through a different door, so it asks the cold-start question VERBATIM
 * ({@link COLD_START_ASK}) — their reply lands in the intake machine, which is tuned for
 * exactly that answer.
 *
 * The AI disclosure sits in the first sentence, matching intake's discipline: honesty
 * that can be skimmed past in a closing parenthetical is not honesty.
 *
 * It carries the STOP line, which the texted cold-start greeting does not, and the
 * difference is the channel. A greeting replies to a text on the channel the parent
 * chose; this one arrives on a channel they did NOT choose, off an inquiry made by
 * phone. CASL's implied-consent-by-inquiry covers the send; the unsubscribe mechanism is
 * what makes it a message a parent can end.
 */
export const VOICE_TEXT_OPENER = `Hi, this is Hale - you just called. I'm an AI that quietly runs the family week, and I work by text. ${COLD_START_ASK} Reply STOP to unsubscribe.`;

/**
 * The text an ENROLLED caller gets. It asks for nothing: Hale already knows their
 * children, their area and their week, and asking a family it has served for months to
 * re-introduce themselves is the single most damaging thing this feature could do. Their
 * reply goes to the coach through the hand-off that already exists (twilio/inbound.ts).
 *
 * No STOP line: they are subscribed, they were told STOP always works when they signed
 * up, and repeating it on every message is the tone of a mailing list.
 */
export const VOICE_TEXT_OPENER_KNOWN =
  "Hi, it's Hale - you just called. I work by text, so tell me here what you need and I'll pick it up.";
