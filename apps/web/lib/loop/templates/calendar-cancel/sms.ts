import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';

/**
 * The cancellation text for an event the parent was texted a tap-to-add link for.
 *
 * The words are the model's (lib/loop/voice/calendar-cancel-voice.ts), always. There is
 * no fixed fallback: when that stage defers, the caller sends nothing and names the
 * deferral (calendar-invite.ts `compose_deferred`), so this renderer only ever sees a
 * composed line.
 *
 * The line is sent as composed, like the invite it takes back (VIL-515): an accent or
 * another script reaches the phone as written, and the destination gate read exactly
 * these bytes. A fold here would delete characters after the gate (VIL-588).
 */

export const CALENDAR_CANCEL_SMS_TEMPLATE_KEY = 'calendar_cancel_sms';

export interface CalendarCancelSmsPayload {
  /** The event's descriptor, already rendered at this parent's privacy level. */
  summary: string;
  /** The start it was going to have, in the family's timezone. */
  when: string;
  /** The composed text. Never empty: a deferred compose is never dispatched. */
  line: string;
}

export function calendarCancelSmsText(payload: CalendarCancelSmsPayload): string {
  return payload.line;
}

export function asCalendarCancelSmsPayload(
  payload: Record<string, unknown>,
): CalendarCancelSmsPayload {
  const p = payload as Partial<CalendarCancelSmsPayload>;
  if (!p.summary || !p.when || typeof p.line !== 'string' || p.line.trim() === '') {
    throw new Error('calendar cancel sms: payload is missing the composed cancellation');
  }
  return p as CalendarCancelSmsPayload;
}

export const calendarCancelSmsRenderer: TemplateRenderer = {
  render(message: LoopMessage, channel: ChannelKind): RenderedContent {
    if (channel !== 'sms') {
      throw new Error(`calendar cancel sms: no ${channel} form of the cancellation`);
    }
    return {
      kind: 'sms',
      text: calendarCancelSmsText(asCalendarCancelSmsPayload(message.payload)),
      modelWritten: true,
    };
  },
};
