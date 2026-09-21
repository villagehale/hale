import { smsSegments } from '~/lib/channel/sms-segments';
import type { RenderedContent } from '~/lib/channel/types';
import { localTimeLabel, whenLead } from '../reminder/core';
import { gsmSafe } from '../weekly-plan/core';
import type { CaregiverReminderEvent, CaregiverReminderPayload } from './payload';

/**
 * A caregiver's event reminder: where to be, when.
 *
 * It shares the parents' lead ("Tomorrow" / "In an hour") and their two-segment ceiling,
 * and diverges in the two places the recipient differs. It carries the LOCATION, which is
 * the half of "event logistics" the parents' copy never needed. And it runs no voice
 * stage: the reminder voice is composed once per parent batch against that parent's own
 * name dial (loop/voice/reminder-voice.ts), so pointing it at a caregiver would spend a
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
  const lead = whenLead(payload.offset);
  const lines = payload.events.map((event) => eventLine(event, payload.timeZone));
  // NO `Hale: ` PREFIX (docs/voice.md rule 2) — see plan-sms.ts.
  const send = (body: string) => gsmSafe(`${lead} - ${body}`);

  const full = send(lines.join(LINE_SEP));
  if (smsSegments(full) <= SEGMENT_CAP) return { kind: 'sms', text: full };

  for (let shown = lines.length - 1; shown >= 1; shown--) {
    const text = send(`${lines.slice(0, shown).join(LINE_SEP)} +${lines.length - shown} more`);
    if (smsSegments(text) <= SEGMENT_CAP) return { kind: 'sms', text };
  }
  // One event whose freeform title is longer than the ceiling on its own. Give way at a
  // word boundary rather than send five segments (the parents' renderer's own trade).
  const words = (lines[0] ?? '').split(' ');
  for (let count = words.length - 1; count >= 1; count--) {
    const text = send(`${words.slice(0, count).join(' ')}...`);
    if (smsSegments(text) <= SEGMENT_CAP) return { kind: 'sms', text };
  }
  return { kind: 'sms', text: send('...') };
}
