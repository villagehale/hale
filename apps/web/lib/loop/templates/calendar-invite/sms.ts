import { smsSegments } from '~/lib/channel/sms-segments';
import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';

/**
 * The calendar invite as a TEXT: one line, one link, tap to add.
 *
 * The words are the model's (lib/loop/voice/calendar-invite-voice.ts), always. There is
 * no fixed confirmation: when that stage defers, the caller sends nothing and names the
 * deferral (calendar-invite.ts `compose_deferred`), so this renderer only ever sees a
 * composed line that already carries the per-event ICS url.
 *
 * The model's words are not folded. An accent or another script has to reach the phone
 * as written. A line that needs more than one SMS segment is split here, at send, into
 * ordered texts. The link is one token, so a split never cuts it in half.
 *
 * `sms-copy-encoding.test.ts` scans this file. A fixed parent-facing sentence does not
 * belong here; the model writes the line, or nothing is sent.
 */

export const CALENDAR_INVITE_SMS_TEMPLATE_KEY = 'calendar_invite_sms';

/** "Wed, Jul 22 at 10:30 AM", in the family's own zone. A fact for the model, not a sentence Hale sends. */
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
 * Split a long text into sendable parts. Each part fits one segment when the words
 * allow it. A token longer than one segment (the link, under UCS-2) stays whole.
 */
export function splitInviteSms(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (smsSegments(trimmed) <= 1) return [trimmed];
  const words = trimmed.split(/\s+/);
  const parts: string[] = [];
  let current = '';
  const push = (part: string) => {
    if (part !== '') parts.push(part);
  };
  for (const word of words) {
    const next = current === '' ? word : `${current} ${word}`;
    if (smsSegments(next) <= 1) {
      current = next;
      continue;
    }
    push(current);
    current = '';
    if (smsSegments(word) <= 1) current = word;
    else push(word);
  }
  push(current);
  return parts;
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
    const line = asCalendarInviteSmsPayload(message.payload).line.trim();
    const texts = splitInviteSms(line);
    return {
      kind: 'sms',
      text: texts.join('\n\n'),
      // The sent words stay on the ledger so a later pass can see whether the
      // part that carries the link actually went out.
      recordBody: true,
      ...(texts.length > 1 ? { texts } : {}),
    };
  },
};
