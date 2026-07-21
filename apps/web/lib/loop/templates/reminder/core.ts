import { deriveStage } from '@hale/types';
import { type ChildNameLevel, loopChildName } from '~/lib/loop/prefs';
import type { ReminderOffset } from '~/lib/loop/reminders/schedule';
import type { ReminderChild, ReminderEventView } from './payload';

/**
 * VIL-223 · D1 reminder template — the pure, channel-agnostic copy helpers. No DB, no
 * LLM, no `new Date()` of their own (`now` is passed so the teen gate is deterministic
 * in tests). Privacy (rule #1) is enforced here: a teen's event is genericized to a
 * bare "an appointment" — no name, no title — and the child_name_level dial attributes
 * a non-teen child only down to the parent's chosen level.
 */

// A teen (or any flagged-sensitive) event is reduced to this — the calendar detail is
// never surfaced, only that SOMETHING is on the parent's radar.
const GENERIC_DESCRIPTOR = 'an appointment';

/** The reminder's opening lead, from the offset: the "evening before" batch reads
 * "Tomorrow", the day-of ping reads "In an hour". */
export function whenLead(offset: ReminderOffset): string {
  return offset === '-P1D' ? 'Tomorrow' : 'In an hour';
}

/** The family-local clock label of an event's start instant — "10:00", "4:30"
 * (12-hour, no meridiem, matching the ticket copy). */
export function localTimeLabel(startsAt: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(new Date(startsAt));
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  return `${hour}:${minute}`;
}

function eventChild(
  event: ReminderEventView,
  children: readonly ReminderChild[],
): ReminderChild | undefined {
  return event.childId ? children.find((c) => c.id === event.childId) : undefined;
}

function isTeen(child: ReminderChild, now: Date): boolean {
  return deriveStage(child.dateOfBirth, now) === 'teenager';
}

/**
 * The event's "what": a teen's or flagged-sensitive event is the bare generic (rule
 * #1 / rule 6). Otherwise the placed title, attributed to the child at the parent's
 * name level ("Maya — Swim class" / "your daughter — Swim class"), but never doubly
 * (a title that already names the child, or the most-private 'generic' level, shows
 * the title alone). family_events titles are freeform, so this attributes rather than
 * rewrites — it cannot re-level a name embedded inside the title.
 */
export function eventDescriptor(
  event: ReminderEventView,
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  now: Date,
): string {
  const child = eventChild(event, children);
  if ((child && isTeen(child, now)) || event.sensitive) return GENERIC_DESCRIPTOR;
  if (child && level !== 'generic' && !event.title.toLowerCase().includes(child.name.toLowerCase())) {
    const leveled = loopChildName({ ...child, gender: child.gender ?? '' }, level, now);
    return `${leveled} — ${event.title}`;
  }
  return event.title;
}

/** One event as a reminder line: "{descriptor} at {time}". */
export function eventLine(
  event: ReminderEventView,
  children: readonly ReminderChild[],
  level: ChildNameLevel,
  now: Date,
  timeZone: string,
): string {
  return `${eventDescriptor(event, children, level, now)} at ${localTimeLabel(event.startsAt, timeZone)}`;
}
