import { deriveStage } from '@hale/types';
import { type ChildNameLevel, loopChildName } from '~/lib/loop/prefs';
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

/**
 * The family-local calendar day of an instant — "Sat, Jul 25". The reminder's lead is this
 * FACT, never a word for how far off the event is: a reminder sent late on the event's own
 * day would otherwise call today "tomorrow". How the day reads in words is the voice's to
 * phrase, from this same fact.
 */
export function localDayLabel(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  }).formatToParts(new Date(instant));
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${value('weekday')}, ${value('month')} ${value('day')}`;
}

/** The lead a reminder opens with: its events' own local day. A batch shares one day (the
 * evening-before batch groups one evening's events, the hour-before ping is one event), so
 * the first event's day is all of theirs. No events is a wiring bug — fail loud. */
export function reminderLead(
  events: readonly Pick<ReminderEventView, 'startsAt'>[],
  timeZone: string,
): string {
  const [first] = events;
  if (!first) throw new Error('reminder: no events to lead with');
  return localDayLabel(first.startsAt, timeZone);
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

function eventChild<C extends Pick<ReminderChild, 'id'>>(
  event: Pick<ReminderEventView, 'childId'>,
  children: readonly C[],
): C | undefined {
  return event.childId ? children.find((c) => c.id === event.childId) : undefined;
}

/** The deterministic age gate itself (rule #1), exported so a surface that holds a DOB
 * without a whole child row still decides teen-ness the one way. */
export function isTeenChild(child: Pick<ReminderChild, 'dateOfBirth'>, now: Date): boolean {
  return deriveStage(child.dateOfBirth, now) === 'teenager';
}

/**
 * Whether an event may carry NO detail outbound: a 13+ child's event (the deterministic
 * age gate, rule #1) or one flagged sensitive. The single predicate behind every
 * outbound surface's genericization — the reminder copy here, the per-event calendar
 * invite (VIL-249) and the texted schedule reader (VIL-270), so they can never drift
 * apart. It declares only the fields it READS, so a caller holding a join row rather
 * than a whole child does not have to fabricate a name to ask the question.
 */
export function isPrivateEvent(
  event: Pick<ReminderEventView, 'childId' | 'sensitive'>,
  children: readonly Pick<ReminderChild, 'id' | 'dateOfBirth'>[],
  now: Date,
): boolean {
  const child = eventChild(event, children);
  return (child !== undefined && isTeenChild(child, now)) || event.sensitive === true;
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
  if (isPrivateEvent(event, children, now)) return GENERIC_DESCRIPTOR;
  if (
    child &&
    level !== 'generic' &&
    !event.title.toLowerCase().includes(child.name.toLowerCase())
  ) {
    const leveled = loopChildName({ ...child, gender: child.gender ?? '' }, level, now);
    return `${leveled} — ${event.title}`;
  }
  return event.title;
}
