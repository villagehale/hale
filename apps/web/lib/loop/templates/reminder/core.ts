import { deriveStage } from '@hale/types';
import { assertPoolSize, nightlyOccasion, pickVariant } from '~/lib/channel/variant';
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

/**
 * The reminder's opening lead, from the offset: the "evening before" batch says tomorrow,
 * the day-of ping says an hour from now.
 *
 * THREE WAYS OF SAYING EACH, rotating once per family-local day. This is the string a
 * family with something on every day reads every single day, twice on the days that carry
 * both offsets — the highest-frequency deterministic words in the loop after the evening
 * ask. The FACT never moves: every member names the same distance in time, because the
 * distance is the whole message.
 *
 * The first member of each is the sentence this renderer shipped with, so the email
 * subject and the SMS still read the way a reviewer remembers on four evenings in nine.
 */
const WHEN_LEAD_POOLS: Record<ReminderOffset, readonly string[]> = {
  '-P1D': ['Tomorrow', 'Coming up tomorrow', 'On for tomorrow'],
  '-PT1H': ['In an hour', 'An hour from now', 'Just about an hour away'],
};
for (const [offset, pool] of Object.entries(WHEN_LEAD_POOLS)) {
  assertPoolSize(pool, `reminder:lead:${offset}`);
}

/** The deterministic lead, unpooled — what the EMAIL subject uses, where a subject line
 * that varied per day would make a thread unrecognisable in a mailbox. */
export function whenLead(offset: ReminderOffset): string {
  return WHEN_LEAD_POOLS[offset][0] as string;
}

/**
 * The lead this family reads on this day.
 *
 * THE OCCASION IS THE EVENT'S OWN LOCAL DAY, not the render clock. The renderer is called
 * with `new Date()` from the template seam, so seeding off `now` would make the same
 * reminder read differently depending on when the job ran — and would make every test of
 * this file depend on the day it is run. The day the reminder is ABOUT is the stable
 * thing, and it advances exactly once per day, which is the rhythm the pool exists for.
 */
export function whenLeadFor(
  offset: ReminderOffset,
  familyId: string,
  firstEventStartsAt: string | undefined,
  timeZone: string,
): string {
  const pool = WHEN_LEAD_POOLS[offset];
  if (firstEventStartsAt === undefined) return pool[0] as string;
  return pickVariant(
    pool,
    `reminder:lead:${offset}`,
    familyId,
    nightlyOccasion(new Date(firstEventStartsAt), timeZone),
  );
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
