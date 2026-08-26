import { smsEncoding } from '~/lib/channel/sms-segments';
import { joinLink } from './code';

/**
 * Every word Hale texts about a co-parent join link, in one file.
 *
 * This is the SPEC, not a template layer (the same contract the intake and caregiver
 * copy keep): the tests assert these strings, so a change to what a partner is PROMISED
 * before they text in is a reviewable diff rather than a quiet widening.
 *
 * THE MINT MESSAGE IS WRITTEN TO BE FORWARDED. It goes to the parent, but the parent's
 * next move is one tap that sends the whole body to somebody who has never heard from
 * Hale — so the second half is addressed to that person, and the first half is the only
 * sentence the parent needs. Splitting it into "here is a link" plus a separate blob to
 * copy would be asking a parent to do editing work in a text thread.
 *
 * WHAT IS NOT SAID HERE, and where it is said instead: the full scope a co-parent gets.
 * The caregiver flow states its scope twice because Hale texts a stranger unprompted and
 * that stranger must be able to refuse something specific. Nobody is texted on this
 * path — the partner arrives on their own — so the scope is stated to the parent at the
 * mint ("whoever opens it is in") and in full to the partner in {@link joinWelcome},
 * which is the first message they ever get and the last moment before they can reply
 * STOP.
 */

/**
 * The one message a parent forwards. Two segments including the link, which is the
 * budget: the link alone costs 72 characters, so everything else is what is left.
 */
export function joinInviteForward(code: string): string {
  return [
    'Forward this to them - whoever opens it is in, so just to them:',
    `Your partner uses Hale to keep the family week straight. Open this from your phone and send the text it writes: ${joinLink(code)} Good for 7 days.`,
  ].join('\n');
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
  const who = affordableInviterName(inviterName) ?? 'The other parent';
  return `You're in - ${who} added you as a co-parent, so you both see the same thing here: the week, the reminders, the plans, anything I'm keeping track of. Text me anything. Reply STOP anytime.`;
}

/** Said to the parent who minted the link, in their own thread, once it is redeemed. */
export const JOIN_ACCEPTED_ACK =
  'Your partner is in - they joined from their own number and they see what you see here.';
