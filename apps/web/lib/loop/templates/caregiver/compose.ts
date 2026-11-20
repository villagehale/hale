import { type EnvBag, isEnabled } from '@hale/flags';
import type { ReplyLanguage } from '~/lib/channel/language';
import type { SpokenLineRequest } from '~/lib/channel/spoken-line';
import { isAllDay, localClockFact, localDateFact, relativeDay } from '~/lib/loop/reminders/compose';
import type { CaregiverReminderPayload } from './payload';

/**
 * VIL-706 · the caregiver reminder, written by the model from facts.
 *
 * Off (the default), the caregiver reminder is the code-built line in reminder-sms.ts,
 * exactly as before. Lit, the reminder run writes the whole text through the spoken-line
 * writer with the `caregiver-reminder` addendum (packages/agent/skills/caregiver-reminder.md)
 * before the leg is enqueued, and the renderer sends those words and nothing else. A
 * reminder the model does not write is dropped as `unwritten` with its audit row: nothing
 * is sent, and the writer has paged #ops. There is no fallback to the code-built line.
 *
 * Exactly `true` turns it on (`CAREGIVER_REMINDER_MODEL_COPY_ENABLED`).
 */
export function caregiverReminderModelCopyEnabled(env: EnvBag = process.env): boolean {
  return isEnabled('caregiver-reminder-model-copy', undefined, env);
}

/** One event the caregiver was cleared to see (`classifyFamilyEvent` already ran). */
export interface CaregiverReminderFactEvent {
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
}

/**
 * The request for one caregiver batch. Facts only, every one of them already cleared for
 * this caregiver upstream: the event's name as the calendar has it, its day and time in
 * the recipient's zone, and where to be. No child, no roster, no note, no link. Each place
 * rides as verbatim, so an address arrives exactly as written or the line is refused.
 */
export function caregiverReminderRequest(args: {
  offset: CaregiverReminderPayload['offset'];
  timeZone: string;
  now: Date;
  language: ReplyLanguage | null;
  events: readonly CaregiverReminderFactEvent[];
}): SpokenLineRequest {
  const facts: Record<string, string> = {
    when: args.offset === '-P1D' ? 'evening_before' : 'hour_before',
    count: String(args.events.length),
  };
  const places: string[] = [];
  args.events.forEach((event, index) => {
    const n = index + 1;
    facts[`event_${n}`] = event.title.trim();
    facts[`date_${n}`] = localDateFact(event.startsAt, args.timeZone);
    const day = relativeDay(event.startsAt, args.now, args.timeZone);
    if (day) facts[`day_${n}`] = day;
    if (isAllDay(event.startsAt, event.endsAt, args.timeZone)) {
      facts[`all_day_${n}`] = 'true';
    } else {
      facts[`start_${n}`] = localClockFact(event.startsAt, args.timeZone);
      if (args.offset === '-PT1H') {
        const minutes = Math.round((event.startsAt.getTime() - args.now.getTime()) / 60_000);
        facts[`minutes_until_${n}`] = String(minutes);
      }
    }
    const place = event.location?.trim();
    if (place) {
      facts[`place_${n}`] = place;
      if (!places.includes(place)) places.push(place);
    }
  });
  return {
    purpose: 'caregiver_reminder',
    language: args.language,
    facts,
    verbatim: places,
    addendum: 'caregiver-reminder',
  };
}
