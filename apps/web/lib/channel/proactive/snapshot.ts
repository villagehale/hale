import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, desc, eq, gte, inArray, isNull, lt, max, ne, sql } from 'drizzle-orm';
import { PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { familyHasTeenager } from '~/lib/dashboard/trail-query';
import { dayKeyOf, formatSnapshotLocalNow } from '~/lib/format/datetime';
import { type CadencePreference, readCadencePreference } from './preference';
import { boundedLine } from './tools';

/**
 * VIL-226 · the family state the decider reads. Calendar, mail, watches, recent sends
 * and the household shape are loaded here. What to do with them lives in the skill.
 *
 * Children are ages, never names. A candidate is its kind and the sweep's names-free
 * label (`why`), never the composed text: that is the writer's input, not the decider's.
 * A household with a teenager has every calendar label read as "busy", every offer title,
 * decline and watch label as `WITHHELD_LABEL`, and none of its parents' texts (rule #1's
 * double-miss fallback: a text names no child, so it cannot be shown not to be about the
 * teen). Other parent texts reach the decider only once, when
 * they arrived after its last look at this family. Calendar titles, Gmail offer titles
 * and watch labels are each one bounded line, like the parent texts.
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
  /** The outbound-gate class, e.g. `nudge`. */
  kind: string;
  /** The sweep's own label for the item, e.g. `weekday_dropin`. No names. */
  why: string;
  sourceUrl: string | null;
  worthlessAfter: string | null;
  parentRequested: boolean;
}

/** What is already on the calendar. A label is a title Hale may read, or "busy". */
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

export interface HouseholdContext {
  areaCoarse: string | null;
  /** Ages in years. No names. */
  childAgesYears: number[];
}

export interface FamilySnapshot {
  timeZone: string;
  /** UTC instant, for the audit trail. Decisions about evening read `localNow`. */
  now: string;
  /** Wall clock plus timezone name: "Thursday 6:00 PM America/New_York". */
  localNow: string;
  household: HouseholdContext;
  calendar: CalendarEntry[];
  /** Entries past `CALENDAR_ROWS` left out of `calendar`. Absent when none were. */
  calendarOmitted?: number;
  freeWindows: FreeWindow[];
  deadlines: { what: string; at: string }[];
  watches: { what: string }[];
  candidates: SnapshotCandidate[];
  recentSends: RecentSend[];
  unansweredStreak: number;
  /** The pace the parent who owns every candidate asked for. Null for a mixed batch. */
  frequencyPreference: Pick<CadencePreference, 'direction' | 'note'> | null;
  declines: string[];
  /** Lines the parent actually sent. The decider reads cadence from these. */
  recentParentTexts: string[];
  priorDecisions: PriorDecision[];
}

const WAKING_START = 9 * 60;
const WAKING_END = 20 * 60;
const MIN_WINDOW = 60;
/** The days ahead the decider sees: the calendar, free windows and a clock-less hold. */
export const SNAPSHOT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_PARENT_TEXTS = 5;
const DEADLINE_ROWS = 40;
const WATCH_ROWS = 20;
/**
 * The calendar entries the decider reads, nearest first: about four a day across the
 * window. Free windows are still cut from every busy row; only the list is capped, and
 * `calendarOmitted` says how many entries it left out.
 */
export const CALENDAR_ROWS = 60;
/** What a teenager's household shows for an offer title, a decline or a watch label. */
export const WITHHELD_LABEL = 'withheld';

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Waking hours over the given days, minus real busy blocks. An all-day block removes the
 * day. A morning block leaves the afternoon.
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

function localMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
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
  label: string;
  startAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  transparency: string | null;
  status: string | null;
}

function isBusy(row: TimedRow): row is TimedRow & { startAt: Date } {
  if (!row.startAt) return false;
  if (row.status === 'cancelled' || row.status === 'free') return false;
  return row.transparency !== 'transparent';
}

function spanOf(row: TimedRow & { startAt: Date }, timeZone: string) {
  const startMin = localMinutes(row.startAt, timeZone);
  const endMin = row.endAt ? localMinutes(row.endAt, timeZone) : startMin + MIN_WINDOW;
  return { startMin, endMin: endMin > startMin ? endMin : startMin + MIN_WINDOW };
}

function blockOf(row: TimedRow & { startAt: Date }, timeZone: string): BusyBlock {
  const day = dayKeyOf(row.startAt, timeZone);
  if (row.allDay) return { day, startMin: 0, endMin: 0, allDay: true };
  return { day, ...spanOf(row, timeZone), allDay: false };
}

function entryOf(row: TimedRow & { startAt: Date }, timeZone: string): CalendarEntry {
  const day = dayKeyOf(row.startAt, timeZone);
  if (row.allDay) return { day, label: row.label, allDay: true, start: null, end: null };
  const { startMin, endMin } = spanOf(row, timeZone);
  return { day, label: row.label, allDay: false, start: clock(startMin), end: clock(endMin) };
}

export interface LoadedFamilyContext {
  timeZone: string;
  household: HouseholdContext;
  calendar: CalendarEntry[];
  calendarOmitted: number;
  freeWindows: FreeWindow[];
  deadlines: { what: string; at: string }[];
  watches: { what: string }[];
  declines: string[];
  /** A child here is 13 or older. */
  teenInHousehold: boolean;
}

/**
 * Calendar free windows for the next fourteen days, open watches, Gmail deadlines still
 * open, and declined offers. The timezone is the primary parent's own; a family with no
 * primary parent has none, and is `null` here rather than a guessed zone.
 */
export async function loadFamilyContext(
  database: Database,
  familyId: string,
  now: Date,
): Promise<LoadedFamilyContext | null> {
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
  if (!zone) return null;
  const timeZone = zone.timezone;
  const redactLabels = await familyHasTeenager(database, familyId);
  const children = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const from = new Date(now.getTime() - DAY_MS);
  const until = new Date(now.getTime() + (SNAPSHOT_DAYS + 1) * DAY_MS);
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
  const label = (title: string | null, sensitive: boolean): string => {
    if (redactLabels || sensitive) return 'busy';
    return boundedLine(title ?? '') || 'busy';
  };
  const line = (text: string): string => (redactLabels ? WITHHELD_LABEL : boundedLine(text));
  const rows: TimedRow[] = [
    ...events.map((row) => ({
      label: label(row.title, row.sensitive),
      startAt: row.startAt,
      endAt: row.endAt,
      allDay: false,
      transparency: row.transparency,
      status: null,
    })),
    ...snapshots.map((row) => ({
      label: label(row.heldTitle, false),
      startAt: row.startAt,
      endAt: row.endAt,
      allDay: row.allDay,
      transparency: row.transparency,
      status: row.status,
    })),
  ];
  const busy = rows.filter(isBusy).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  const listed = busy.slice(0, CALENDAR_ROWS);
  const offers = await database
    .select({
      title: schema.emailAlertOffers.title,
      startsAt: schema.emailAlertOffers.startsAt,
      resolution: schema.emailAlertOffers.resolution,
      expiresAt: schema.emailAlertOffers.expiresAt,
    })
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.familyId, familyId))
    .limit(DEADLINE_ROWS);
  const watches = await database
    .select({ label: schema.watchedSpots.label })
    .from(schema.watchedSpots)
    .where(and(eq(schema.watchedSpots.familyId, familyId), isNull(schema.watchedSpots.releasedAt)))
    .limit(WATCH_ROWS);
  return {
    timeZone,
    household: {
      areaCoarse: zone.areaCoarse,
      childAgesYears: children.map((child) => ageYears(child.dateOfBirth, now)),
    },
    calendar: listed.map((row) => entryOf(row, timeZone)),
    calendarOmitted: busy.length - listed.length,
    freeWindows: freeWindowsForDays(
      upcomingDayKeys(now, timeZone, SNAPSHOT_DAYS),
      busy.map((row) => blockOf(row, timeZone)),
    ),
    deadlines: offers
      .filter((offer) => offer.resolution === null && offer.expiresAt.getTime() > now.getTime())
      .map((offer) => ({ what: line(offer.title), at: offer.startsAt.toISOString() })),
    watches: watches.map((watch) => ({ what: line(watch.label) })),
    declines: offers
      .filter((offer) => offer.resolution === 'declined')
      .map((offer) => line(offer.title)),
    teenInHousehold: redactLabels,
  };
}

const PROACTIVE_CATEGORIES = [...new Set(Object.values(PROACTIVE_CATEGORY))];

/** The decision audit row a cadence preference is kept on (preference.ts). */
const CADENCE_DECISION_ACTION = 'proactive_cadence_decision';

/** The latest pace this one parent asked for, from the decision rows that kept it. */
async function latestCadence(
  database: Database,
  familyId: string,
  parentUserId: string,
): Promise<CadencePreference | null> {
  const [row] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, CADENCE_DECISION_ACTION),
        sql`${schema.auditLog.after} -> 'cadencePreference' ->> 'parentUserId' = ${parentUserId}`,
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(1);
  if (!row) return null;
  return readCadencePreference((row.after as { cadencePreference?: unknown }).cadencePreference);
}

export interface LoadedSnapshot {
  snapshot: FamilySnapshot;
  /** Who sent the texts in `recentParentTexts`. Never handed to the model. */
  textAuthors: string[];
  /** The one parent who owns every candidate, whose pace `frequencyPreference` is. */
  owner: string | null;
}

/** The full snapshot for one family: the loaded context plus the thread's last 14 days. */
export async function loadFamilySnapshot(
  database: Database,
  input: {
    familyId: string;
    context: LoadedFamilyContext;
    candidates: SnapshotCandidate[];
    /** Every parent who owns one of `candidates`. */
    candidateParents: readonly string[];
    priorDecisions: PriorDecision[];
    now: Date;
  },
): Promise<LoadedSnapshot> {
  const since = new Date(input.now.getTime() - SNAPSHOT_DAYS * DAY_MS);
  const messages = await database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      direction: schema.channelMessages.direction,
      category: schema.channelMessages.category,
      createdAt: schema.channelMessages.createdAt,
      body: schema.channelMessages.body,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  const inbound = messages
    .filter((row) => row.direction === 'in')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const recentSends: RecentSend[] = messages
    .filter(
      (row) =>
        row.direction === 'out' &&
        (PROACTIVE_CATEGORIES as readonly string[]).includes(row.category),
    )
    .map((row) => ({
      at: row.createdAt.toISOString(),
      replied: inbound.some((text) => text.createdAt.getTime() > row.createdAt.getTime()),
    }));
  const [onlyOwner, ...otherOwners] = input.candidateParents;
  const owner = onlyOwner !== undefined && otherOwners.length === 0 ? onlyOwner : null;
  const cadence = owner !== null ? await latestCadence(database, input.familyId, owner) : null;
  const [lastReview] = await database
    .select({ at: max(schema.proactiveCandidates.decidedAt) })
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, input.familyId));
  const lastReviewAt = lastReview?.at ?? null;
  const { context } = input;
  const newTexts = context.teenInHousehold
    ? []
    : inbound.filter((row) => lastReviewAt === null || row.createdAt > lastReviewAt);
  const shown = newTexts
    .map((row) => ({ author: row.parentUserId, text: boundedLine(row.body ?? '') }))
    .filter((row) => row.text.length > 0)
    .slice(-RECENT_PARENT_TEXTS);
  const snapshot: FamilySnapshot = {
    timeZone: context.timeZone,
    now: input.now.toISOString(),
    localNow: formatSnapshotLocalNow(input.now, context.timeZone),
    household: context.household,
    calendar: context.calendar,
    ...(context.calendarOmitted > 0 ? { calendarOmitted: context.calendarOmitted } : {}),
    freeWindows: context.freeWindows,
    deadlines: context.deadlines,
    watches: context.watches,
    candidates: input.candidates,
    recentSends,
    unansweredStreak: unansweredStreak(recentSends),
    frequencyPreference: cadence ? { direction: cadence.direction, note: cadence.note } : null,
    declines: context.declines,
    recentParentTexts: shown.map((row) => row.text),
    priorDecisions: input.priorDecisions,
  };
  return { snapshot, textAuthors: [...new Set(shown.map((row) => row.author))], owner };
}
