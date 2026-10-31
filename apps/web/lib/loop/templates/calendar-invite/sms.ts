import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';
import { gsmSafe } from '../weekly-plan/core';

/**
 * The calendar invite as a TEXT: one line, one link, tap to add.
 *
 * The words are the model's (lib/loop/voice/calendar-invite-voice.ts), always. There is
 * no fixed confirmation: when that stage defers, the caller sends nothing and names the
 * deferral (calendar-invite.ts `compose_deferred`), so this renderer only ever sees a
 * composed line that already carries the per-event ICS url. Folded through `gsmSafe`
 * on the way out, the same way the cancellation it pairs with is folded.
 *
 * The fold is load-bearing. The descriptor arrives at runtime from a family_events row,
 * and `eventDescriptor` attributes a title to its child with an em dash ("Maya — Swim
 * class") at any name level above 'generic'. One character outside GSM-7 re-encodes the
 * whole body as UCS-2. Folded, not stripped: the dash becomes a hyphen, so a parent who
 * turned names on still reads the name. The link is untouched by the fold (a base64url
 * token is hyphen-minus and underscore, both GSM-7).
 *
 * `sms-copy-encoding.test.ts` scans this file. A fixed parent-facing sentence does not
 * belong here; the model writes the line, or nothing is sent.
 */

export const CALENDAR_INVITE_SMS_TEMPLATE_KEY = 'calendar_invite_sms';

/** "Wed, Jul 22 at 10:30 AM", in the family's own zone. */
export function inviteWhenLabel(startsAt: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(startsAt);
  return `${day} at ${time}`;
}

export interface CalendarInviteSmsPayload {
  /** The event's descriptor, already rendered at this parent's privacy level. */
  summary: string;
  /** The start, formatted in the family's timezone (inviteWhenLabel). */
  when: string;
  /** The absolute per-event ICS link. */
  url: string;
  /** The composed text, link already filled. Never empty: a deferred compose is never dispatched. */
  line: string;
}

/**
 * The whole body, link included. The composer filled the link; folding here is the
 * alphabet the carrier is billed on, and it does not touch a base64url token.
 */
export function calendarInviteSmsText(payload: CalendarInviteSmsPayload): string {
  return gsmSafe(payload.line);
}

export function asCalendarInviteSmsPayload(
  payload: Record<string, unknown>,
): CalendarInviteSmsPayload {
  const p = payload as Partial<CalendarInviteSmsPayload>;
  // Every field is a FACT the composer resolved (the redacted descriptor, the family's
  // own timezone, the minted link, the model's line). A missing one is a caller that
  // skipped the composer — a wiring bug, not a state to render around (rule #8).
  if (
    !p.summary ||
    !p.when ||
    !p.url ||
    typeof p.line !== 'string' ||
    p.line.trim() === '' ||
    !p.line.includes(p.url)
  ) {
    throw new Error('calendar invite sms: payload is missing the composed link');
  }
  return p as CalendarInviteSmsPayload;
}

/**
 * SMS only. The link is inside the composed line, and a non-sms channel has no form
 * of it. A throw here means the pin was removed — a wiring bug.
 */
export const calendarInviteSmsRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    if (channel !== 'sms') {
      throw new Error(`calendar invite sms: no ${channel} form of the tap-to-add link`);
    }
    return {
      kind: 'sms',
      text: calendarInviteSmsText(asCalendarInviteSmsPayload(message.payload)),
    };
  },
};
