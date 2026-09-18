import type { ChannelKind, LoopMessage, RenderedContent, TemplateRenderer } from '~/lib/channel/types';
import { gsmSafe } from '../weekly-plan/core';

/**
 * The calendar invite as a TEXT: one line, one link, tap to add.
 *
 * WHY IT EXISTS. The invite shipped on one channel — an email with a text/calendar part
 * — so a family that has only ever texted Hale (users.email null: every SMS-intake
 * family) said YES and got "Approved - add to calendar. I'll let you know once it's
 * done." with no artifact anywhere near their phone. The event landed on Hale's own
 * family_events and nowhere else. The per-event link primitive that fixes it was already
 * deployed and had no callers (lib/loop/ics-invite.ts mintEventInviteLink, served by
 * app/api/ics/event/[token]); this is the copy that carries it.
 *
 * IT LIVES IN ITS OWN MODULE, apart from the email template next door, for a mechanical
 * reason: `sms-copy-encoding.test.ts` scans whole FILES for characters outside GSM-7,
 * and the email template is full of them (an em dash, a middle dot, HTML). A text is
 * billed by encoding, so the one file a carrier's alphabet applies to is kept separate
 * and scanned.
 *
 * THE SCAN IS NOT ENOUGH BY ITSELF, which is why the body is FOLDED through `gsmSafe`
 * on the way out, exactly as the reminder SMS folds its own. Only the authored words
 * are in this file; the descriptor arrives at runtime from a family_events row, and
 * `eventDescriptor` attributes a title to its child with an EM DASH ("Maya — Swim
 * class") at any name level above 'generic'. One character outside the alphabet
 * re-encodes the WHOLE body as UCS-2 — 67 units a part instead of 153 — so the same
 * text bills four segments instead of two, for a difference nobody on a phone can see.
 * Folded, not stripped: the dash becomes a hyphen and an accent its base letter, so a
 * parent who turned names on still reads the name.
 *
 * DETERMINISTIC, unlike its two neighbours. The email's note and the address ask are
 * COMPOSED per send (founder, 2026-08-12: no preset message bodies) because they are
 * prose. This is not prose: it is a receipt for a decision the parent made seconds ago,
 * plus the link that makes it real — the same class as `approvedReceipt` and
 * `connectorOfferReply`, which are authored, locked and segment-tested rather than
 * written per send. A model in this path would buy nothing and could split the link.
 *
 * ENGLISH ONLY, and deliberately. Hale's fixed copy picks a language from the message
 * in front of it (lib/channel/language.ts — per message, never stored), and this text is
 * composed by the EXECUTOR off a queue with no message in front of it, exactly like the
 * "Approved" receipt it follows. `families.primary_language` is not the missing input
 * either: the column is declared and has no reader and no writer anywhere in the repo,
 * so keying a twin on it would hand every family 'en' while looking like it did not.
 * Shipping a French twin no caller can reach would be a second, unexercised alphabet to
 * keep GSM-7-safe (fr-CA formats August as "aout" with a circumflex, which re-encodes
 * the whole body as UCS-2 and doubles its cost).
 */

export const CALENDAR_INVITE_SMS_TEMPLATE_KEY = 'calendar_invite_sms';

export interface CalendarInviteSmsPayload {
  /** The event's descriptor, already rendered at this parent's privacy level. */
  summary: string;
  /** The start, formatted in the family's timezone (inviteWhenLabel). */
  when: string;
  /** The absolute per-event ICS link. */
  url: string;
}

/**
 * The whole body, link included — composed here and nowhere else, so no later fitting
 * can split the sentence from the URL it is about.
 *
 * The verb is "Added" for the same reason the emailed twin says it: a move rides the
 * same iTIP REQUEST and lands on the same UID, so tapping either one updates the entry
 * in place rather than adding a second.
 *
 * Folded once, here, over the whole assembled body — the alphabet applies to what the
 * carrier is handed, not to the fragments, and the link is untouched by the fold (a
 * base64url token is hyphen-minus and underscore, both GSM-7).
 */
export function calendarInviteSmsText(payload: CalendarInviteSmsPayload): string {
  return gsmSafe(
    `Added - ${payload.summary}, ${payload.when}. Tap to put it on your phone's calendar: ${payload.url}`,
  );
}

export function asCalendarInviteSmsPayload(
  payload: Record<string, unknown>,
): CalendarInviteSmsPayload {
  const p = payload as Partial<CalendarInviteSmsPayload>;
  // Every field is a FACT the composer resolved (the redacted descriptor, the family's
  // own timezone, the minted link). A missing one is a caller that skipped the composer
  // — a wiring bug, not a state to render around (rule #8).
  if (!p.summary || !p.when || !p.url) {
    throw new Error('calendar invite sms: payload is missing the composed link');
  }
  return p as CalendarInviteSmsPayload;
}

/**
 * SMS only, the mirror of the email renderer's pin: the link IS the message, and an
 * email carrying it instead of the attachment would be a worse version of the email
 * that already exists. A throw here means the pin was removed — a wiring bug.
 */
export const calendarInviteSmsRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    if (channel !== 'sms') {
      throw new Error(`calendar invite sms: no ${channel} form of the tap-to-add link`);
    }
    return { kind: 'sms', text: calendarInviteSmsText(asCalendarInviteSmsPayload(message.payload)) };
  },
};
