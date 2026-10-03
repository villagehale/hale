import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { REMINDER_HORIZON_MS } from '~/lib/loop/reminders/schedule';
import { zonedMidnight } from '~/lib/memory/period';

/**
 * A connected Google Calendar becomes reminder rows without a YES (VIL-416).
 *
 * The reminder cron only reads `family_events` whose source is `placement` or
 * `parent`. A raw calendar event never reached that table until a parent
 * answered an email offer, so a swim class that was already on the calendar
 * was silent. This module writes the eligible ones as `source = 'parent'`
 * mirrors. The cron then schedules the same two offsets — 18:00 local the
 * evening before, and one hour before — and the send stays on `channel.send`,
 * which is where consent, the frequency cap and quiet hours are enforced.
 *
 * What is not a mirror:
 *   - declined (the parent's own response, or a cancelled event)
 *   - already started
 *   - an all-day busy block (out of office, focus, working location, or an
 *     all-day "Busy" with no occasion in the title)
 *   - an occasion Hale already has as a placement or a parent YES (same title,
 *     same start). That row already reminds the household; a second one would
 *     text it twice.
 *
 * A mirror reminds only the parent who connected that calendar. The description
 * and the attendee list are never stored (rule #1).
 */

const TITLE_MAX = 180;
const LOCATION_MAX = 80;
const START_MATCH_MS = 60_000;
const GENERIC_TITLE = 'Something on your calendar';

const BUSY_EVENT_TYPES = new Set(['outOfOffice', 'focusTime', 'workingLocation']);
const BUSY_TITLES = new Set(['busy', 'out of office']);

export type CalendarMirrorSkip =
  | 'no_id'
  | 'cancelled'
  | 'declined'
  | 'past'
  | 'no_start'
  | 'busy_block'
  | 'already_known';

export interface CalendarMirrorCandidate {
  eventId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
}

export type CalendarMirrorClass =
  | { kind: 'eligible'; candidate: CalendarMirrorCandidate }
  | { kind: 'skip'; reason: Exclude<CalendarMirrorSkip, 'already_known'>; eventId: string | null };

export interface CalendarMirrorCounts {
  mirrored: number;
  updated: number;
  removed: number;
  alreadyKnown: number;
  skipped: number;
  /** The window was empty and not trustworthy, so nothing was written or deleted. */
  held: boolean;
}

export function emptyCalendarMirrorCounts(held = false): CalendarMirrorCounts {
  return { mirrored: 0, updated: 0, removed: 0, alreadyKnown: 0, skipped: 0, held };
}

interface GoogleTime {
  dateTime?: string;
  date?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timePoint(value: unknown): GoogleTime | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const point = value as { dateTime?: unknown; date?: unknown };
  const dateTime = readString(point.dateTime);
  const date = readString(point.date);
  return dateTime === undefined && date === undefined ? undefined : { dateTime, date };
}

/** Local midnight of a Google all-day `date`, in the parent's zone. */
function allDayInstant(day: string, timeZone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const instant = zonedMidnight(day, timeZone);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function cleanText(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.includes('@')) return null;
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

function selfDeclined(item: Record<string, unknown>): boolean {
  if (!Array.isArray(item.attendees)) return false;
  for (const attendee of item.attendees) {
    if (typeof attendee !== 'object' || attendee === null) continue;
    const row = attendee as { self?: unknown; responseStatus?: unknown };
    if (row.self === true && row.responseStatus === 'declined') return true;
  }
  return false;
}

function isBusyBlock(item: Record<string, unknown>, allDay: boolean): boolean {
  const eventType = readString(item.eventType);
  if (eventType !== undefined && BUSY_EVENT_TYPES.has(eventType)) return true;
  if (!allDay) return false;
  const summary = readString(item.summary)?.trim().toLowerCase() ?? '';
  return summary.length === 0 || BUSY_TITLES.has(summary);
}

/**
 * Whether one raw events.list item may become a reminder. Pure: `now` and the
 * parent's zone are passed in.
 */
export function classifyCalendarMirrorItem(
  item: Record<string, unknown>,
  now: Date,
  timeZone: string,
): CalendarMirrorClass {
  const eventId = readString(item.id) ?? null;
  if (eventId === null) return { kind: 'skip', reason: 'no_id', eventId: null };
  const status = readString(item.status);
  if (status === 'cancelled') return { kind: 'skip', reason: 'cancelled', eventId };
  if (selfDeclined(item)) return { kind: 'skip', reason: 'declined', eventId };

  const start = timePoint(item.start);
  if (!start) return { kind: 'skip', reason: 'no_start', eventId };
  const allDay = start.date !== undefined && start.dateTime === undefined;
  if (isBusyBlock(item, allDay)) return { kind: 'skip', reason: 'busy_block', eventId };

  const startsAt = start.dateTime
    ? new Date(start.dateTime)
    : allDayInstant(start.date ?? '', timeZone);
  if (!startsAt || Number.isNaN(startsAt.getTime())) {
    return { kind: 'skip', reason: 'no_start', eventId };
  }
  if (startsAt.getTime() <= now.getTime()) return { kind: 'skip', reason: 'past', eventId };

  const end = timePoint(item.end);
  let endsAt: Date | null = null;
  if (end?.dateTime) {
    const parsed = new Date(end.dateTime);
    if (!Number.isNaN(parsed.getTime())) endsAt = parsed;
  } else if (end?.date) {
    endsAt = allDayInstant(end.date, timeZone);
  }

  const title = cleanText(readString(item.summary) ?? '', TITLE_MAX) ?? GENERIC_TITLE;
  const location = cleanText(readString(item.location) ?? '', LOCATION_MAX);

  return {
    kind: 'eligible',
    candidate: { eventId, title, startsAt, endsAt, location },
  };
}

export function normalizeMirrorTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\.+$/, '');
}

/** A Hale-authored row already covers this occasion, so a mirror would double the reminder. */
export function knownEventCovers(
  candidate: CalendarMirrorCandidate,
  known: { title: string; startsAt: Date },
): boolean {
  if (normalizeMirrorTitle(candidate.title) !== normalizeMirrorTitle(known.title)) return false;
  return Math.abs(candidate.startsAt.getTime() - known.startsAt.getTime()) <= START_MATCH_MS;
}

/**
 * Reconcile one connection's upcoming window onto `family_events`.
 *
 * `trustWindow` is false when the list itself failed or came back short. An
 * empty untrusted window writes nothing. A short window still upserts what it
 * saw, and does not delete: a missing event is then "we did not see it", not
 * "the parent deleted it".
 */
export async function reconcileCalendarMirrors(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    integrationId: string;
    items: readonly Record<string, unknown>[];
    timeZone: string;
    now: Date;
    trustWindow: boolean;
  },
): Promise<CalendarMirrorCounts> {
  if (!input.trustWindow && input.items.length === 0) return emptyCalendarMirrorCounts(true);
  const allowRemoval = input.trustWindow;

  const counts = emptyCalendarMirrorCounts(false);
  const horizonEnd = new Date(input.now.getTime() + REMINDER_HORIZON_MS);
  const eligible: CalendarMirrorCandidate[] = [];
  for (const item of input.items) {
    const classified = classifyCalendarMirrorItem(item, input.now, input.timeZone);
    if (classified.kind === 'skip') {
      counts.skipped += 1;
      continue;
    }
    if (classified.candidate.startsAt.getTime() > horizonEnd.getTime()) {
      counts.skipped += 1;
      continue;
    }
    eligible.push(classified.candidate);
  }

  const known = await database
    .select({
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, input.familyId),
        inArray(schema.familyEvents.source, ['placement', 'parent']),
        isNull(schema.familyEvents.deletedAt),
        isNull(schema.familyEvents.googleEventId),
        gte(schema.familyEvents.startsAt, input.now),
        lte(schema.familyEvents.startsAt, horizonEnd),
      ),
    );

  const mirrors = await database
    .select({
      id: schema.familyEvents.id,
      googleEventId: schema.familyEvents.googleEventId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      deletedAt: schema.familyEvents.deletedAt,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.integrationId, input.integrationId),
        isNotNull(schema.familyEvents.googleEventId),
      ),
    );
  const mirrorByEvent = new Map(
    mirrors.flatMap((row) => (row.googleEventId ? [[row.googleEventId, row] as const] : [])),
  );

  const kept = new Set<string>();
  for (const candidate of eligible) {
    if (known.some((row) => knownEventCovers(candidate, row))) {
      counts.alreadyKnown += 1;
      const stale = mirrorByEvent.get(candidate.eventId);
      if (stale && stale.deletedAt === null) {
        await softDeleteMirror(database, input, stale.id);
        stale.deletedAt = input.now;
        counts.removed += 1;
      }
      continue;
    }
    kept.add(candidate.eventId);
    const existing = mirrorByEvent.get(candidate.eventId);
    if (!existing) {
      const inserted = await database
        .insert(schema.familyEvents)
        .values({
          familyId: input.familyId,
          title: candidate.title,
          startsAt: candidate.startsAt,
          endsAt: candidate.endsAt,
          location: candidate.location,
          source: 'parent',
          createdBy: input.userId,
          googleEventId: candidate.eventId,
          integrationId: input.integrationId,
        })
        .onConflictDoNothing()
        .returning({ id: schema.familyEvents.id });
      const id = inserted[0]?.id;
      if (!id) continue;
      counts.mirrored += 1;
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'calendar_mirror_added',
        targetTable: 'family_events',
        targetId: id,
        after: { source: 'parent' },
      });
      continue;
    }

    const moved = existing.startsAt.getTime() !== candidate.startsAt.getTime();
    const changed =
      moved ||
      existing.title !== candidate.title ||
      (existing.location ?? null) !== candidate.location ||
      (existing.endsAt?.getTime() ?? null) !== (candidate.endsAt?.getTime() ?? null) ||
      existing.deletedAt !== null;
    if (!changed) continue;
    await database
      .update(schema.familyEvents)
      .set({
        title: candidate.title,
        startsAt: candidate.startsAt,
        endsAt: candidate.endsAt,
        location: candidate.location,
        deletedAt: null,
        createdBy: input.userId,
      })
      .where(eq(schema.familyEvents.id, existing.id));
    counts.updated += 1;
    if (moved || existing.deletedAt !== null) {
      const actionTaken =
        existing.deletedAt !== null ? 'calendar_mirror_added' : 'calendar_mirror_moved';
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: 'system',
        actionTaken,
        targetTable: 'family_events',
        targetId: existing.id,
        after: { source: 'parent' },
      });
    }
  }

  if (allowRemoval) {
    for (const row of mirrors) {
      if (!row.googleEventId || kept.has(row.googleEventId) || row.deletedAt !== null) continue;
      if (row.startsAt.getTime() < input.now.getTime()) continue;
      if (row.startsAt.getTime() > horizonEnd.getTime()) continue;
      await softDeleteMirror(database, input, row.id);
      counts.removed += 1;
    }
  }

  return counts;
}

async function softDeleteMirror(
  database: Database,
  input: { familyId: string; now: Date },
  id: string,
): Promise<void> {
  await database
    .update(schema.familyEvents)
    .set({ deletedAt: input.now })
    .where(and(eq(schema.familyEvents.id, id), isNull(schema.familyEvents.deletedAt)));
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'calendar_mirror_removed',
    targetTable: 'family_events',
    targetId: id,
    after: { source: 'parent' },
  });
}
