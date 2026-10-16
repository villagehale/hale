import type { CoParentRefusal } from '~/lib/channel/caregiver/invites';
import type { ReplyLanguage } from '~/lib/channel/language';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { speak } from '~/lib/channel/spoken-line';

/**
 * VIL-355 · every word Hale texts about a CO-PARENT invite, in one file.
 *
 * This is the SPEC, not a template layer (the contract the intake, caregiver and join
 * copy all keep): the tests assert these strings, so a change to what a partner is
 * PROMISED before Hale texts them is a reviewable diff.
 *
 * WHY THE CAREGIVER STRINGS COULD NOT BE REUSED WHOLESALE. They name the wrong thing to
 * the wrong person: `NUMBER_IN_USE` says "I can't add it as a caregiver", and the scope
 * sentences enumerate a slice ("the week's schedule and nothing else") that is the exact
 * opposite of what a co-parent gets. A co-parent's scope is not a list, it is "what you
 * see", and saying it as a list would understate it.
 *
 * BILINGUAL, unlike the caregiver copy, and that is the point rather than an extra. This
 * is the one path in the product where Hale's FIRST EVER message to a person is
 * unprompted, and a Quebec stranger getting it in English only is the Law 25 / Charter
 * exposure the house's own ARRET/AIDE pattern (intake/copy.ts, CRTC §3.1) already exists
 * to answer. The language is read per message off the words in front of us
 * (language.ts) — the parent's own reply for their side, and the parent's authorising
 * reply for the invite, since the invitee has not written anything yet.
 *
 * GSM-7 ONLY, both languages, and inside two segments. `ç`, `â`, `ê`, `î`, `ô` and `û`
 * are NOT in the GSM-7 basic alphabet (only `é è à ù ì ò Ç` are), so one of them
 * anywhere in a French body collapses the budget from 306 units to 134 and splits a
 * stranger's first message into three. copy.test.ts holds the line.
 */

/** The longest inviter name this path will spend budget on — the same ceiling the
 * forwardable link keeps (join/copy.ts), because the two bodies are the same size. */
const MAX_INVITER_NAME_CHARS = 24;

/**
 * Whether the invite can afford to NAME the person who asked for it.
 *
 * DIVERGES DELIBERATELY from `affordableInviterName` (join/copy.ts), which drops an
 * unaffordable name and sends an anonymous body. A forwarded link is handed over by a
 * human who is standing right there; this is a cold text. "A parent added you as their
 * co-parent" from a number nobody recognises is the message this whole feature exists to
 * not send, so an unnameable inviter REFUSES the invite (`referrer_unnamed`) rather than
 * sending it anonymously.
 */
export function inviterNameIsAffordable(inviterName: string | null): inviterName is string {
  const trimmed = inviterName?.trim() ?? '';
  if (trimmed === '' || trimmed.length > MAX_INVITER_NAME_CHARS) return false;
  return smsEncoding(trimmed) === 'gsm7';
}

/**
 * What Hale asks the parent before the number is texted.
 *
 * It states the scope as the two powers a co-parent actually gets — the whole read
 * surface (`role-scope.ts`: `co_parent: PARENT_SCOPE`) and the ability to approve — and
 * not as a list of content classes. Both halves have to be there: a parent who reads
 * only "they see your week" has not been told that this person can say yes to Hale.
 */
/**
 * What Hale asks the parent before the number is texted is written per send
 * (consent-ask, kind coparent_scope). It states both powers — the whole read
 * surface and the ability to approve — in `language`. There is no fixed sentence.
 */

/**
 * THE ONE MESSAGE. Who asked (by name — see {@link inviterNameIsAffordable}), what Hale
 * DOES, what saying yes gets them, and how to stop. The opt-out rides on the first message
 * a stranger ever gets from us, in the language it is written in.
 *
 * IT NO LONGER SAYS "assistant" (docs/voice.md rule 3), and the two twins lose the word
 * together: this file has full FR parity and a register change applied to one language is
 * a product that sounds like two.
 */
/**
 * The first text a co-parent receives is written per send (consent-ask, kind
 * coparent_invite). It names who asked, what agreeing gets them, and the carrier
 * opt-out (STOP, or ARRET in French). There is no fixed sentence.
 */

/** Said to the parent once the invite is on its way. */
export function coParentInviteSentAck(
  name: string,
  language: ReplyLanguage | null,
): Promise<string | null> {
  return speak({ purpose: 'coparent_invite_sent', language, facts: { name } });
}

/** Said to the parent when they answer the scope question with a no. */
export function coParentInviteDroppedAck(
  name: string,
  language: ReplyLanguage | null,
): Promise<string | null> {
  return speak({ purpose: 'coparent_invite_dropped', language, facts: { name } });
}

/** The partner's first message AFTER they accept. */
export function coParentWelcome(
  inviterName: string | null,
  language: ReplyLanguage | null,
): Promise<string | null> {
  return speak({
    purpose: 'coparent_welcome',
    language,
    facts: { inviterName: inviterName ?? '' },
  });
}

/** The invitee said no. The inviting parent is told nothing. */
export function coParentDeclineAck(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'coparent_decline_ack', language });
}

export function coParentReferrerUnnamed(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'coparent_referrer_unnamed', language });
}

export function coParentUnavailable(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'coparent_unavailable', language });
}

export function coParentSeatTakenLate(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'coparent_seat_taken_late', language });
}

export function coParentDepartedNotice(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'coparent_departed_notice', language });
}

export function coParentInviteExpired(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'coparent_invite_expired', language });
}

const REFUSAL_PURPOSE: Record<CoParentRefusal, string> = {
  own_number: 'coparent_own_number',
  number_in_use: 'coparent_number_in_use',
  already_invited: 'coparent_already_invited',
  too_many: 'coparent_too_many',
  co_parent_seat_taken: 'coparent_seat_taken',
  previously_declined: 'coparent_previously_declined',
  referrer_unnamed: 'coparent_referrer_unnamed',
  unavailable: 'coparent_unavailable',
};

/** A named refusal. A new reason is a compile error until it has a purpose. */
export function coParentRefusal(
  reason: CoParentRefusal,
  language: ReplyLanguage | null,
): Promise<string | null> {
  return speak({ purpose: REFUSAL_PURPOSE[reason], language });
}

/**
 * A nudge when the reply was neither yes nor no is written per send
 * (consent-ask, kind coparent_nudge). There is no fixed sentence.
 */
