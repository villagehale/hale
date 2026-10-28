import type { RenderedContent } from '~/lib/channel/types';
import type { ReminderPayload } from './payload';

/**
 * The reminder SMS. The model wrote the whole message from facts
 * (loop/reminders/compose.ts); this renderer adds nothing: no day lead, no
 * "title at time" line, no joined list, no link or suffix, no character folding.
 * `recordBody` asks the dispatch to keep the sent text on the channel_messages row.
 */
export function renderReminderSms(payload: ReminderPayload): RenderedContent {
  return { kind: 'sms', text: payload.text, recordBody: true };
}
