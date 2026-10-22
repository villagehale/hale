import type {
  ChannelKind,
  LoopMessage,
  RenderedContent,
  TemplateRenderer,
} from '~/lib/channel/types';
import { gsmSafe } from '../weekly-plan/core';

/**
 * The cancellation text for an event the parent was texted a tap-to-add link for.
 *
 * The words are the model's (lib/loop/voice/calendar-cancel-voice.ts). When that stage
 * defers, `line` is null and the deterministic receipt below goes instead — a parent
 * planning around a cancelled event is worse off with no text than with a plain one.
 * Folded through `gsmSafe` like the invite it takes back.
 */

export const CALENDAR_CANCEL_SMS_TEMPLATE_KEY = 'calendar_cancel_sms';

export interface CalendarCancelSmsPayload {
  /** The event's descriptor, already rendered at this parent's privacy level. */
  summary: string;
  /** The start it was going to have, in the family's timezone. */
  when: string;
  /** The composed text, or null when the composer deferred. */
  line: string | null;
}

export function calendarCancelSmsText(payload: CalendarCancelSmsPayload): string {
  return gsmSafe(
    payload.line ??
      `Cancelled - ${payload.summary}, ${payload.when}. You can take it off your calendar.`,
  );
}

export function asCalendarCancelSmsPayload(
  payload: Record<string, unknown>,
): CalendarCancelSmsPayload {
  const p = payload as Partial<CalendarCancelSmsPayload>;
  if (!p.summary || !p.when || p.line === undefined) {
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
    };
  },
};
