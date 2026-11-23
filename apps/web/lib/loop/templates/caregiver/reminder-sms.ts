import { smsSegments } from '~/lib/channel/sms-segments';
import type { RenderedContent } from '~/lib/channel/types';
import { localTimeLabel, reminderLead } from '../reminder/core';
import { gsmSafe } from '../weekly-plan/core';
import { caregiverReminderModelCopyEnabled } from './compose';
import type { CaregiverReminderEvent, CaregiverReminderPayload } from './payload';

/**
 * A caregiver's event reminder: where to be, when.
 *
 * VIL-706 · with CAREGIVER_REMINDER_MODEL_COPY_ENABLED lit, the model wrote the whole
 * text from facts before the leg was enqueued (compose.ts), and this renderer sends
 * `payload.texts` as written: no lead, no line, no fold. A lit leg that arrives with no
 * composed text is a caller that skipped the writer, and it throws rather than render
 * around it, so the send holds. The code-built body below is the flag-off answer only,
 * kept until the flag is lit and proven; it is never a fallback for a line the model
 * did not write.
 *
 * It shares the parents' lead (the events' own local day) and their two-segment ceiling,
 * and diverges in the two places the recipient differs. It carries the LOCATION, which is
 * the half of "event logistics" the parents' copy never needed. And it runs no voice
 * stage: the reminder voice is composed once per parent batch against that parent's own
 * name dial (loop/reminders/compose.ts), so pointing it at a caregiver would spend a
 * model call to write a stranger a sentence in somebody else's register.
 *
 * No genericization branch here, and that is not an omission: an event a caregiver may
 * not see never reaches this renderer — `classifyFamilyEvent` removed the teenager's and
 * the health-flagged ones in the run, so there is nothing left to reduce to "an
 * appointment". Adding a second gate here would imply the first one might not have run.
 */

const LINE_SEP = ', ';
const SEGMENT_CAP = 2;

function eventLine(event: CaregiverReminderEvent, timeZone: string): string {
  const line = `${event.title} at ${localTimeLabel(event.startsAt, timeZone)}`;
  return event.location ? `${line}, ${event.location}` : line;
}

export function renderCaregiverReminderSms(payload: CaregiverReminderPayload): RenderedContent {
  if (payload.texts) {
    return {
      kind: 'sms',
      text: payload.texts.join('\n\n'),
      ...(payload.texts.length > 1 ? { texts: [...payload.texts] } : {}),
      modelWritten: true,
    };
  }
  if (caregiverReminderModelCopyEnabled()) {
    throw new Error('caregiver reminder renderer: model copy is lit and no text was composed');
  }
  const lead = reminderLead(payload.events, payload.timeZone);
  const lines = payload.events.map((event) => eventLine(event, payload.timeZone));
  // NO `Hale: ` PREFIX (docs/voice.md rule 2).
  const send = (body: string) => gsmSafe(`${lead} - ${body}`);

  const full = send(lines.join(LINE_SEP));
  if (smsSegments(full) <= SEGMENT_CAP) return { kind: 'sms', text: full, modelWritten: false };

  for (let shown = lines.length - 1; shown >= 1; shown--) {
    const text = send(`${lines.slice(0, shown).join(LINE_SEP)} +${lines.length - shown} more`);
    if (smsSegments(text) <= SEGMENT_CAP) return { kind: 'sms', text, modelWritten: false };
  }
  // One event whose freeform title is longer than the ceiling on its own. Give way at a
  // word boundary rather than send five segments (the parents' renderer's own trade).
  const words = (lines[0] ?? '').split(' ');
  for (let count = words.length - 1; count >= 1; count--) {
    const text = send(`${words.slice(0, count).join(' ')}...`);
    if (smsSegments(text) <= SEGMENT_CAP) return { kind: 'sms', text, modelWritten: false };
  }
  return { kind: 'sms', text: send('...'), modelWritten: false };
}
