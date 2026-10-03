import { type Database, schema } from '@hale/db';
import { and, eq, gt, gte, isNull, lte } from 'drizzle-orm';
import { isTeenChild } from '~/lib/loop/templates/reminder/core';

/**
 * The parent's Google Calendar is the week. A kid event already on it is not
 * something Hale asks to add — reminders, conflicts and the coach read it from
 * here, and a Hale-side `family_events` copy exists only so a move or a cancel
 * has an `eventId`. That copy is silent: nothing in this file sends a text.
 */

export function foldEventTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Same title and the same start instant, on a confirmed connected calendar. */
export async function calendarHoldsEvent(
  database: Database,
  input: { familyId: string; title: string; startsAt: Date },
): Promise<boolean> {
  const folded = foldEventTitle(input.title);
  if (folded === '') return false;
  const rows = await database
    .select({
      title: schema.parentCalendarBlocks.title,
      kidRelated: schema.parentCalendarBlocks.kidRelated,
    })
    .from(schema.parentCalendarBlocks)
    .where(
      and(
        eq(schema.parentCalendarBlocks.familyId, input.familyId),
        eq(schema.parentCalendarBlocks.status, 'confirmed'),
        eq(schema.parentCalendarBlocks.startAt, input.startsAt),
      ),
    );
  return rows.some(
    (row) => row.kidRelated && row.title !== null && foldEventTitle(row.title) === folded,
  );
}

export interface CalendarMirrorCounts {
  mirrored: number;
  alreadyHeld: number;
  skippedTeen: number;
}

/**
 * A future kid event on the connected calendar, copied onto `family_events` so
 * the reminder scheduler, the conflict check and `propose_calendar_move` /
 * `propose_calendar_cancel` can see it. `source = 'parent'` is the one value
 * both the reminder reader and the weekly-plan composer already admit, and the
 * composer's `needs` for a family event is `none` — the plan uses the row and
 * does not ask to add it.
 *
 * A title that names a 13+ child is left on the calendar block only. Mirroring
 * it would put the raw title on a reminder, which the block path already
 * withholds (rule #1).
 */
export async function mirrorFutureCalendarHolds(
  database: Database,
  input: { familyId: string; start: Date; end: Date; now: Date },
): Promise<CalendarMirrorCounts> {
  const counts: CalendarMirrorCounts = { mirrored: 0, alreadyHeld: 0, skippedTeen: 0 };
  const [blocks, children] = await Promise.all([
    database
      .select({
        title: schema.parentCalendarBlocks.title,
        startAt: schema.parentCalendarBlocks.startAt,
        endAt: schema.parentCalendarBlocks.endAt,
        userId: schema.parentCalendarBlocks.userId,
      })
      .from(schema.parentCalendarBlocks)
      .where(
        and(
          eq(schema.parentCalendarBlocks.familyId, input.familyId),
          eq(schema.parentCalendarBlocks.status, 'confirmed'),
          eq(schema.parentCalendarBlocks.kidRelated, true),
          gt(schema.parentCalendarBlocks.startAt, input.now),
          gte(schema.parentCalendarBlocks.startAt, input.start),
          lte(schema.parentCalendarBlocks.startAt, input.end),
        ),
      ),
    database
      .select({ name: schema.children.name, dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId)),
  ]);

  const teenNames = children
    .filter((child) => isTeenChild({ dateOfBirth: child.dateOfBirth }, input.now))
    .map((child) => child.name);

  for (const block of blocks) {
    if (!block.title || !block.startAt) continue;
    if (mentionsAnyName(block.title, teenNames)) {
      counts.skippedTeen += 1;
      continue;
    }
    const held = await familyHolds(database, input.familyId, block.title, block.startAt);
    if (held) {
      counts.alreadyHeld += 1;
      continue;
    }
    const [inserted] = await database
      .insert(schema.familyEvents)
      .values({
        familyId: input.familyId,
        childId: null,
        title: block.title,
        startsAt: block.startAt,
        endsAt: block.endAt,
        location: null,
        source: 'parent',
        createdBy: block.userId,
      })
      .returning({ id: schema.familyEvents.id });
    if (!inserted) continue;
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'calendar_event_mirrored',
      targetTable: 'family_events',
      targetId: inserted.id,
      // Shape only. The title is already on the parent's own calendar.
      after: { source: 'google_calendar' },
    });
    counts.mirrored += 1;
  }
  return counts;
}

async function familyHolds(
  database: Database,
  familyId: string,
  title: string,
  startsAt: Date,
): Promise<boolean> {
  const folded = foldEventTitle(title);
  const rows = await database
    .select({ title: schema.familyEvents.title })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        eq(schema.familyEvents.startsAt, startsAt),
        isNull(schema.familyEvents.deletedAt),
      ),
    );
  return rows.some((row) => foldEventTitle(row.title) === folded);
}

function mentionsAnyName(title: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const token = name.trim();
    if (token.length < 2) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(
      ` ${title} `,
    );
  });
}
