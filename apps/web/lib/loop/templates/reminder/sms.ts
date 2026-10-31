import type { RenderedContent } from '~/lib/channel/types';
import type { ReminderPayload } from './payload';

/**
 * The reminder SMS. The model wrote the whole message from facts
 * (loop/reminders/compose.ts); this renderer adds nothing: no day lead, no
 * "title at time" line, no joined list, no link or suffix, no character folding.
 * The model chose how many texts to send (VIL-467); the dispatch sends each, in
 * order. `text` is the same texts joined, read only by the dispatch's claim gate.
 * `recordBody` asks the dispatch to keep each sent text on its channel_messages row.
 */
export function renderReminderSms(payload: ReminderPayload): RenderedContent {
  return {
    kind: 'sms',
    text: payload.texts.join('\n\n'),
    texts: [...payload.texts],
    recordBody: true,
    ...(payload.bold ? { bold: payload.bold } : {}),
  };
}
