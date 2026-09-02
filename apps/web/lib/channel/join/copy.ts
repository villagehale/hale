import { smsEncoding } from '~/lib/channel/sms-segments';
import { joinLink } from './code';

/**
 * Every word Hale texts about a co-parent join link, in one file.
 *
 * This is the SPEC, not a template layer (the same contract the intake and caregiver
 * copy keep): the tests assert these strings, so a change to what a partner is PROMISED
 * before they text in is a reviewable diff rather than a quiet widening.
 *
 * THE MINT MESSAGE CARRIES ZERO CEREMONY (doctrine R10/L5): what it is, the link, one
 * warning, stop. The old shape stacked four instructions in front of the tap; a parent
 * forwarding a link is doing one move, and the copy matches it — the link first, then
 * the single fact worth saying before the body leaves their thread.
 *
 * WHAT IS NOT SAID HERE, and where it is said instead: the full scope a co-parent gets.
 * The caregiver flow states its scope twice because Hale texts a stranger unprompted and
 * that stranger must be able to refuse something specific. Nobody is texted on this
 * path — the partner arrives on their own — so the scope is stated to the parent at the
 * mint ("whoever opens it joins your family") and in full to the partner in
 * {@link joinWelcome},
 * which is the first message they ever get and the last moment before they can reply
 * STOP.
 */

/**
 * The one message a parent forwards. Two segments including the link, which is the
 * budget: the link alone costs 72 characters, so everything else is what is left.
 */
export function joinInviteForward(code: string): string {
  return `Here you go - forward this to them and they're in: ${joinLink(code)} Just to them, though: whoever opens it joins your family. Good for 7 days.`;
}

/** The longest inviter name this message will spend budget on — a full name, with room
 * to spare against the two-segment ceiling the rest of the body already leans on. */
const MAX_INVITER_NAME_CHARS = 24;

/**
 * The inviter's name if this message can afford it, else null.
 *
 * `users.name` is free text a parent typed, and it is the one part of this body Hale did
 * not write. ONE character outside GSM-7 re-encodes the WHOLE message as UCS-2 and cuts
 * the budget from 306 characters to 134 (sms-segments.ts), so "Zoe" with a diaeresis or
 * a name in any script but Latin would split the partner's first message into three.
 *
 * DROPPED, NOT FOLDED — the call `affordableNames` makes in health/copy.ts, and the one
 * sms-copy-encoding.test.ts makes about never folding at the transport: respelling
 * somebody as "Zoe" on the first sentence they ever get from Hale is worse than not
 * naming them, and the anonymous form is already a sentence that works.
 */
function affordableInviterName(inviterName: string | null): string | null {
  const trimmed = inviterName?.trim() ?? '';
  if (trimmed === '' || trimmed.length > MAX_INVITER_NAME_CHARS) return null;
  return smsEncoding(trimmed) === 'gsm7' ? trimmed : null;
}

/**
 * The partner's first message from Hale: who added them, what they now share, and how
 * to leave. The STOP line is CASL's and rides on the first message, exactly as it does
 * on a caregiver invite.
 */
export function joinWelcome(inviterName: string | null): string {
  const who = affordableInviterName(inviterName) ?? 'your co-parent';
  return `You're in - ${who} added you as a co-parent, so you see what they see here and can text me anything, anytime. Reply STOP anytime.`;
}

/** Said to the parent who minted the link, in their own thread, once it is redeemed. */
export const JOIN_ACCEPTED_ACK =
  'Your partner is in - they joined from their own number and they see what you see here.';
