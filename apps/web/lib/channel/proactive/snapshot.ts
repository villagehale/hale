import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull, lt, ne } from 'drizzle-orm';
import { dayKeyOf } from '~/lib/format/datetime';

/**
 * VIL-226 · the family state the decider reads. Calendar, mail, watches, and
 * the household shape are loaded here. Guidance about what to do with them
 * lives in the skill, not here.
 */

export interface FreeWindow {
  day: string;
  start: string;
  end: string;
}

export interface BusyBlock {
  day: string;
  /** Minutes from local midnight. Ignored when `allDay` is true. */
  startMin: number;
  endMin: number;
  allDay: boolean;
}

export interface SnapshotCandidate {
  id: string;
  what: string;
  why: string;
  sourceUrl: string | null;
  worthlessAfter: string | null;
  parentRequested: boolean;
  dedupeKey: string;
}

/** What is already on the calendar. A label is a title Hale may say, or "busy". */
export interface CalendarEntry {
  day: string;
  label: string;
  allDay: boolean;
  start: string | null;
  end: string | null;
}

/** A hold the decider already made. The hourly review does not reopen it early. */
export interface PriorDecision {
  id: string;
  action: 'held';
  at: string | null;
  reason: string | null;
  holdUntil: string | null;
}

export interface RecentSend {
  at: string;
  replied: boolean;
}

export interface CadencePreference {
  direction: 'less' | 'more';
  note: string;
}

export interface HouseholdContext {
  areaCoarse: string | null;
  /** Ages in years. No names. */
  childAgesYears: number[];
}

export interface FamilySnapshot {
  timeZone: string;
  now: string;
  household: HouseholdContext;
  calendar: CalendarEntry[];
  freeWindows: FreeWindow[];
  deadlines: { what: string; at: string }[];
  watches: { what: string }[];
  candidates: SnapshotCandidate[];
  recentSends: RecentSend[];
  unansweredStreak: number;
  frequencyPreference: CadencePreference | null;
  declines: string[];
  /** Inbound lines the parent actually sent. The decider reads cadence from these. */
  recentParentTexts: string[];
  priorDecisions: PriorDecision[];
}

const WAKING_START = 9 * 60;
const WAKING_END = 20 * 60;
const MIN_WINDOW = 60;

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Waking hours over the given days, minus real busy blocks. An all-day block
 * removes the day. A morning block leaves the afternoon.
 */
export function freeWindowsForDays(
  days: readonly string[],
  blocks: readonly BusyBlock[],
): FreeWindow[] {
  const windows: FreeWindow[] = [];
  for (const day of days) {
    const dayBlocks = blocks.filter((block) => block.day === day);
    if (dayBlocks.some((block) => block.allDay)) continue;
    const cuts = dayBlocks
      .map((block) => ({
        start: Math.max(WAKING_START, block.startMin),
        end: Math.min(WAKING_END, block.endMin),
      }))
      .filter((block) => block.end > block.start)
      .sort((a, b) => a.start - b.start);
    let cursor = WAKING_START;
    for (const cut of cuts) {
      if (cut.start - cursor >= MIN_WINDOW) {
        windows.push({ day, start: clock(cursor), end: clock(cut.start) });
      }
      cursor = Math.max(cursor, cut.end);
    }
    if (WAKING_END - cursor >= MIN_WINDOW) {
      windows.push({ day, start: clock(cursor), end: clock(WAKING_END) });
    }
  }
  return windows;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function upcomingDayKeys(now: Date, timeZone: string, count: number): string[] {
  const first = dayKeyOf(now, timeZone);
  const keys = [first];
  const cursor = new Date(`${first}T12:00:00.000Z`);
  for (let i = 1; i < count; i += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    keys.push(cursor.toISOString().slice(0, 10));
  }
  return keys;
}

function localMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function ageYears(dob: string, now: Date): number {
  const [year, month, day] = dob.split('-').map(Number);
  if (!year || !month || !day) return 0;
  let age = now.getUTCFullYear() - year;
  const nowMonth = now.getUTCMonth() + 1;
  if (nowMonth < month || (nowMonth === month && now.getUTCDate() < day)) age -= 1;
  return Math.max(0, age);
}

interface TimedRow {
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  transparency: string | null;
  status: string | null;
}

function blocksFrom(rows: readonly TimedRow[], timeZone: string): BusyBlock[] {
  const blocks: BusyBlock[] = [];
  for (const row of rows) {
    if (!row.startAt) continue;
    if (row.status === 'cancelled' || row.status === 'free') continue;
    if (row.transparency === 'transparent') continue;
    const day = dayKeyOf(row.startAt, timeZone);
    if (row.allDay) {
      blocks.push({ day, startMin: 0, endMin: 0, allDay: true });
      continue;
    }
    const startMin = localMinutes(row.startAt, timeZone);
    const endMin = row.endAt ? localMinutes(row.endAt, timeZone) : startMin + 60;
    blocks.push({
      day,
      startMin,
      endMin: endMin > startMin ? endMin : startMin + 60,
      allDay: false,
    });
  }
  return blocks;
}

function calendarEntry(
  startAt: Date,
  endAt: Date | null,
  allDay: boolean,
  timeZone: string,
  label: string,
): CalendarEntry {
  const day = dayKeyOf(startAt, timeZone);
  if (allDay) return { day, label, allDay: true, start: null, end: null };
  const startMin = localMinutes(startAt, timeZone);
  const endMin = endAt ? localMinutes(endAt, timeZone) : startMin + 60;
  return {
    day,
    label,
    allDay: false,
    start: clock(startMin),
    end: clock(endMin > startMin ? endMin : startMin + 60),
  };
}

export interface LoadedFamilyContext {
  timeZone: string;
  household: HouseholdContext;
  calendar: CalendarEntry[];
  freeWindows: FreeWindow[];
  deadlines: { what: string; at: string }[];
  watches: { what: string }[];
  declines: string[];
}

/**
 * Calendar free windows for 14 days, open watches, Gmail deadlines still
 * unanswered, and declined offers. Names stay out.
 */
export async function loadFamilyContext(
  database: Database,
  familyId: string,
  now: Date,
): Promise<LoadedFamilyContext> {
  const [zone] = await database
    .select({ timezone: schema.users.timezone, areaCoarse: schema.families.areaCoarse })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .innerJoin(schema.families, eq(schema.families.id, schema.familyMembers.familyId))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  const timeZone = zone?.timezone ?? 'America/Toronto';
  if (!zone) {
    console.error({ familyId }, 'proactive cadence: no primary parent — timezone defaulted');
  }
  const children = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const days = upcomingDayKeys(now, timeZone, 14);
  const from = new Date(now.getTime() - DAY_MS);
  const until = new Date(now.getTime() + 15 * DAY_MS);
  const events = await database
    .select({
      title: schema.familyEvents.title,
      startAt: schema.familyEvents.startsAt,
      endAt: schema.familyEvents.endsAt,
      transparency: schema.familyEvents.transparency,
      sensitive: schema.familyEvents.sensitive,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        householdFamilyEvent(),
        gte(schema.familyEvents.startsAt, from),
        lt(schema.familyEvents.startsAt, until),
      ),
    );
  const snapshots = await database
    .select({
      startAt: schema.calendarEventSnapshots.startAt,
      endAt: schema.calendarEventSnapshots.endAt,
      allDay: schema.calendarEventSnapshots.allDay,
      status: schema.calendarEventSnapshots.status,
      transparency: schema.calendarEventSnapshots.transparency,
      heldTitle: schema.calendarEventSnapshots.heldTitle,
    })
    .from(schema.calendarEventSnapshots)
    .innerJoin(
      schema.integrations,
      eq(schema.calendarEventSnapshots.integrationId, schema.integrations.id),
    )
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        inArray(schema.integrations.provider, ['gcal', 'apple_cal']),
        ne(schema.calendarEventSnapshots.status, 'cancelled'),
        gte(schema.calendarEventSnapshots.startAt, from),
        lt(schema.calendarEventSnapshots.startAt, until),
      ),
    );
  const blocks = blocksFrom(
    [
      ...events.map((row) => ({
        startAt: row.startAt,
        endAt: row.endAt,
        allDay: false,
        transparency: row.transparency,
        status: null,
      })),
      ...snapshots.map((row) => ({
        startAt: row.startAt,
        endAt: row.endAt,
        allDay: row.allDay,
        transparency: row.transparency,
        status: row.status,
      })),
    ],
    timeZone,
  );
  const offers = await database
    .select({
      title: schema.emailAlertOffers.title,
      startsAt: schema.emailAlertOffers.startsAt,
      resolution: schema.emailAlertOffers.resolution,
      expiresAt: schema.emailAlertOffers.expiresAt,
    })
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.familyId, familyId))
    .limit(40);
  const watches = await database
    .select({ label: schema.watchedSpots.label })
    .from(schema.watchedSpots)
    .where(and(eq(schema.watchedSpots.familyId, familyId), isNull(schema.watchedSpots.releasedAt)))
    .limit(20);
  const calendar = [
    ...events.flatMap((row) => {
      if (!row.startAt || row.transparency === 'transparent') return [];
      return [
        calendarEntry(
          row.startAt,
          row.endAt,
          false,
          timeZone,
          row.sensitive ? 'A commitment' : row.title,
        ),
      ];
    }),
    ...snapshots.flatMap((row) => {
      if (!row.startAt || row.status === 'cancelled' || row.status === 'free') return [];
      if (row.transparency === 'transparent') return [];
      return [
        calendarEntry(
          row.startAt,
          row.endAt,
          row.allDay,
          timeZone,
          row.heldTitle?.trim() || 'busy',
        ),
      ];
    }),
  ];
  return {
    timeZone,
    household: {
      areaCoarse: zone?.areaCoarse ?? null,
      childAgesYears: children.map((child) => ageYears(child.dateOfBirth, now)),
    },
    calendar,
    freeWindows: freeWindowsForDays(days, blocks),
    deadlines: offers
      .filter((offer) => offer.resolution === null && offer.expiresAt.getTime() > now.getTime())
      .map((offer) => ({ what: offer.title, at: offer.startsAt.toISOString() })),
    watches: watches.map((watch) => ({ what: watch.label })),
    declines: offers.filter((offer) => offer.resolution === 'declined').map((offer) => offer.title),
  };
}

/** How many proactive sends in a row got nothing back, newest first. */
export function unansweredStreak(sends: readonly RecentSend[]): number {
  const ordered = [...sends].sort((a, b) => (a.at < b.at ? 1 : -1));
  let streak = 0;
  for (const send of ordered) {
    if (send.replied) break;
    streak += 1;
  }
  return streak;
}
