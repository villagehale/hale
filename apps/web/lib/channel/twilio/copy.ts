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
export const VOICE_TEXT_OPENER = `Hi, this is Hale - you just called. I watch rec mornings so they don't sneak up, and I work by text. ${COLD_START_ASK} Reply STOP to unsubscribe.`;

/**
 * Voice v1 — the first thing an ENROLLED caller hears, spoken by Twilio before the socket
 * has said anything. It is the compliance disclosure and it is not optional.
 *
 * Three facts, in the order a person needs them. That this is an AI and not a person —
 * first, before they say anything they would only say to a human. That the conversation
 * is WRITTEN DOWN into the thread they already have, which is the disclosure that makes
 * the channel_messages rows honest rather than surveillance. And that the AUDIO is not
 * kept, which is true by construction: there is no `record` attribute and no
 * `intelligenceService` on the TwiML, so Twilio retains neither recording nor transcript
 * (rule #1).
 *
 * It ends by naming the exit. A parent who did not want to talk to an AI can hang up and
 * text, and saying so out loud costs three seconds and removes the only trap in the
 * feature.
 */
export const VOICE_RELAY_GREETING =
  "Hi, it's Hale - I'm an AI assistant, not a person. I'll write down what we talk about so it stays with your family's thread; I don't keep a recording of your voice. You can always text me instead.";

/**
 * Spoken when a turn breaks — the model refused, timed out, or the loop threw.
 *
 * FIXED, not composed, and that is the whole point: the thing that speaks when the model
 * failed cannot itself need the model. It is also the one line here that must never
 * promise a fix, because nothing is retrying behind it.
 */
export const VOICE_TURN_FAILED =
  "Sorry - I lost that one. Say it again, or text me and I'll pick it up there.";

/**
 * Spoken at the nine-minute cap, then the line goes down.
 *
 * A call has to end somewhere: the platform's own ceiling is a hang-up with no warning,
 * and a parent who is mid-sentence when that happens has been dropped by Hale. This ends
 * it while Hale is still the one talking, and points at the channel that has no cap.
 */
export const VOICE_CALL_WRAP_UP =
  "I need to let you go - we've been on a while. Text me anything else and I'll pick it up there. Bye for now.";

/**
 * Voice v2 — the line that fills the pause while a tool runs.
 *
 * A tool turn costs a couple of seconds, and on a phone a couple of seconds of nothing is
 * not "thinking", it is a dropped call. The skill asks the model to say something itself
 * before it reaches for a tool, which is the version that sounds like a person; this is
 * the GUARANTEE underneath that request — spoken only when the model reached for a tool
 * having said nothing at all, so the caller never hears the line twice and never hears
 * silence (voice-turn.ts).
 *
 * Deliberately not "one moment please": a receptionist's phrase, and the one register the
 * skill spends a section telling the model to avoid.
 */
export const VOICE_TOOL_ACK = 'Let me check.';

/**
 * The two approval receipts a CALL cannot borrow from the texting router.
 *
 * `nothingPendingReply` and `nothingToUndoReply` both end in an app URL, which is the
 * right answer in a message a parent can tap and an unusable one read out loud — a
 * spoken URL is thirty syllables of punctuation nobody can write down while driving.
 * Everything else the approvals grammar says (approved, dropped, which one, already
 * handled) is one plain sentence and is spoken exactly as texted, so these are the only
 * two lines here rather than a second voice-shaped copy of the whole receipt set.
 *
 * They say the same FACT as their texted twins and stop where the link would start.
 */
export const VOICE_NOTHING_PENDING = "Nothing's waiting on your approval right now.";
export const VOICE_NOTHING_TO_UNDO = "There's nothing from the last day I can take back.";

/**
 * A handler settled the caller's answer and answered on ANOTHER channel (the plan lane
 * sends its texts and hands the router no body). Unreachable while a call can only settle
 * approvals, and named rather than left as silence (rule #11): the parent said yes to
 * something, something happened, and the line they hear has to be true of a turn whose
 * words went somewhere else.
 */
export const VOICE_ANSWERED_BY_TEXT = "I've got that one - it's coming to you by text.";

/**
 * The turn broke AFTER it had already drafted changes (the VIL-260 shape, out loud).
 *
 * {@link VOICE_TURN_FAILED} says "I lost that one", and on a turn that minted rows that
 * is false twice over: something did happen, and the parent who is never told about it
 * cannot answer it — so the next unrelated yes is what finds it. This says the count and
 * never what the drafts are (the type alone can name a teenager's action, rule #1), and
 * it names the answer a caller can give with their voice.
 */
export function voiceDraftedButFailed(draftCount: number): string {
  const noun = draftCount === 1 ? 'one change' : `${draftCount} changes`;
  return `I couldn't finish that, but I've got ${noun} waiting on your OK. Say yes and I'll put that through.`;
}
