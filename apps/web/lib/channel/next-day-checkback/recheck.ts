import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  LOOKAHEAD_DAYS,
  LOOKBACK_DAYS,
  MAX_ENTRIES,
  type WatchCalendarCheck,
  type WatchCalendarEntry,
  type WatchCalendarRead,
  createWatchCalendarCheck,
  createWatchCalendarReader,
  loadWatchCalendar,
} from '~/lib/channel/activity/calendar-check';
import { familyLocalNow } from '~/lib/channel/coach/local-now';
import { knownHouseholdTimezone, knownParentTimezone } from '~/lib/channel/household-timezone';
import { withoutTeenTitles } from '~/lib/channel/linq/kid-event';
import { boundedLine } from '~/lib/channel/proactive/tools';
import { teenChildIds } from '~/lib/channel/role-scope';
import { pipelineClient } from '~/lib/pipeline/client';
import { nextDayCheckbackEnabled } from './flag';
import { type NextDayCheckbackPayload, askerReturned } from './sweep';

/**
 * VIL-681 · at send time, is the ask still unfinished? The sweep queued it a while ago;
 * the decider may have chosen it hours later. Read again, in order:
 *
 *   1. the lane flag (the kill switch: a queued item stops on the next review);
 *   2. the workstream, which must still be the one the sweep queued;
 *   3. any text from the asker since the ask (they came back; that turn owns it);
 *   4. the asker's clock: their own zone, else the household's. The gate reads their
 *      quiet floor on it, never on the UTC column default;
 *   5. the household calendar and the asker's own bookings, read by the VIL-564 model
 *      reader: did they already sign up somewhere Hale did not see?
 *
 * Only `owed` sends. `unsure` is closed too: fewer asks wins ties. A read that failed, or
 * a clock Hale does not know, is `unchecked`: held with no clock, never sent, and it
 * expires with the candidate.
 */

export type OpenAskClosedReason =
  | 'lane_off'
  | 'ask_moved'
  | 'parent_returned'
  | 'finished_elsewhere'
  | 'maybe_finished';

export type OpenAskRecheck =
  | { verdict: 'owed'; timeZone: string }
  | { verdict: 'closed'; reason: OpenAskClosedReason }
  | { verdict: 'unchecked'; reason: 'recheck_failed' | 'zone_unknown' };

export type RecheckOpenAsk = (
  database: Database,
  item: {
    familyId: string;
    parentUserId: string;
    dedupeKey: string;
    payload: Record<string, unknown> | null;
    now: Date;
  },
) => Promise<OpenAskRecheck>;

const DAY_MS = 86_400_000;

function askOf(payload: Record<string, unknown> | null): NextDayCheckbackPayload {
  const ask = payload?.nextDayCheckback as Record<string, unknown> | undefined;
  if (
    !ask ||
    typeof ask.workstreamId !== 'string' ||
    typeof ask.anchorAt !== 'string' ||
    !(ask.subjectChildId === null || typeof ask.subjectChildId === 'string')
  ) {
    throw new Error('next-day check-back: a candidate with no workstream payload');
  }
  return {
    workstreamId: ask.workstreamId,
    anchorAt: ask.anchorAt,
    subjectChildId: ask.subjectChildId,
  };
}

export function createRecheckOpenAsk(check: WatchCalendarCheck): RecheckOpenAsk {
  return async (database, item) => {
    const closed = (reason: OpenAskClosedReason): OpenAskRecheck => ({
      verdict: 'closed',
      reason,
    });
    if (!nextDayCheckbackEnabled()) return closed('lane_off');
    const ask = askOf(item.payload);
    const ws = schema.familyWorkstreams;
    const [row] = await database
      .select()
      .from(ws)
      .where(and(eq(ws.id, ask.workstreamId), eq(ws.familyId, item.familyId)))
      .limit(1);
    if (
      !row ||
      row.status !== 'waiting_on_parent' ||
      row.closedAt !== null ||
      row.checkBackAt !== null ||
      row.lastFollowedUpAt !== null ||
      row.expiresAt.getTime() <= item.now.getTime() ||
      row.updatedAt.toISOString() !== ask.anchorAt
    ) {
      return closed('ask_moved');
    }
    if (
      await askerReturned(database, {
        familyId: item.familyId,
        parentUserId: item.parentUserId,
        anchor: row.updatedAt,
        updatedFrom: row.updatedFrom,
      })
    ) {
      return closed('parent_returned');
    }
    const timeZone = await knownParentTimezone(database, {
      familyId: item.familyId,
      parentUserId: item.parentUserId,
    });
    if (timeZone === null) return { verdict: 'unchecked', reason: 'zone_unknown' };
    const seen = await check.check(database, {
      familyId: item.familyId,
      parentUserId: item.parentUserId,
      subjectChildId: ask.subjectChildId,
      subject: boundedLine(row.title),
      heardFacts: [],
      now: item.now,
    });
    switch (seen.outcome) {
      case 'on_calendar':
        return closed('finished_elsewhere');
      case 'not_on_calendar':
      case 'calendar_empty':
        return { verdict: 'owed', timeZone };
      case 'calendar_unchecked':
        if (seen.reason === 'unsure') return closed('maybe_finished');
        if (seen.reason === 'zone_unknown') return { verdict: 'unchecked', reason: 'zone_unknown' };
        return { verdict: 'unchecked', reason: 'recheck_failed' };
    }
  };
}

/** The production re-check: the VIL-564 reader over the booking-aware calendar. */
export function defaultRecheckOpenAsk(): RecheckOpenAsk {
  return createRecheckOpenAsk(
    createWatchCalendarCheck(createWatchCalendarReader(pipelineClient), loadCheckbackCalendar),
  );
}

/**
 * The household calendar as the VIL-564 reader sees it, with the asker's own bookings
 * that never reached it in front: a confirmation email Hale read but nobody placed. Only
 * the asker's mailbox (rule #5), and a title that names a 13+ child never leaves here.
 */
export async function loadCheckbackCalendar(
  database: Database,
  input: { familyId: string; parentUserId: string; subjectChildId: string | null; now: Date },
): Promise<WatchCalendarRead> {
  const read = await loadWatchCalendar(database, input);
  if (read.status !== 'read') return read;
  const zone = await knownHouseholdTimezone(database, input.familyId);
  if (!zone) return { status: 'zone_unknown' };
  const b = schema.activityBookings;
  const [bookings, children] = await Promise.all([
    database
      .select({ title: b.title, firstSessionAt: b.firstSessionAt })
      .from(b)
      .where(
        and(
          eq(b.familyId, input.familyId),
          eq(b.parentUserId, input.parentUserId),
          isNull(b.cancelledAt),
          isNull(b.eventId),
          gte(b.firstSessionAt, new Date(input.now.getTime() - LOOKBACK_DAYS * DAY_MS)),
          lte(b.firstSessionAt, new Date(input.now.getTime() + LOOKAHEAD_DAYS * DAY_MS)),
        ),
      )
      .orderBy(asc(b.firstSessionAt)),
    database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId)),
  ]);
  const teens = teenChildIds(children, input.now);
  const titled = withoutTeenTitles(
    bookings.map((row) => ({ ...row, kidRelated: true })),
    children.map((child) => child.name),
    children.filter((child) => teens.has(child.id)).map((child) => child.name),
  );
  const booked: WatchCalendarEntry[] = [];
  for (const row of titled) {
    if (row.title === null || row.title.trim() === '') continue;
    const start = familyLocalNow(row.firstSessionAt, zone);
    booked.push({
      title: row.title.trim(),
      day: `${start.date} (${start.weekday})`,
      start: start.time,
      end: null,
    });
  }
  return {
    status: 'read',
    today: read.today,
    calendar: [...booked, ...read.calendar].slice(0, MAX_ENTRIES),
  };
}
