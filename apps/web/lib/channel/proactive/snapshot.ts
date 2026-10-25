import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
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
 * teen). The decider's own earlier words are withheld there the same way: a prior hold's
 * reason reads as `WITHHELD_LABEL`, since it was written with parent texts in view. In
 * every household it reads so in any batch that is not wholly the held row's owner's: it
 * was written with that parent's texts and own calendar titles in view (rule #5). A kept
 * pace is its direction alone in every household (preference.ts). Other parent texts
 * reach the decider only from the one parent who owns every candidate (none for a batch
 * two parents own, rule #5), each until one review of that parent's batch has read it,
 * once per mode (`ParentTextsRead`), and only those rows' bodies are read. Calendar
 * titles, Gmail offer titles and watch labels are each one bounded line, like the parent
 * texts. A title from one parent's own connected calendar is shown only in a batch that
 * is wholly theirs, and reads as "busy" in anyone else's (rule #5). A Gmail offer title, a
 * decline and a watch label follow the same rule: each came from one parent's mailbox or
 * was asked for by one parent, and reads as `WITHHELD_LABEL` in any batch that is not
 * wholly that parent's.
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

/**
 * A prior hold as loaded, before the batch's owner is known. `parentUserId` is whose row
 * the hold is on, and is never handed to the model: `loadFamilySnapshot` reads it and
 * leaves it behind.
 */
export interface LoadedPriorDecision extends PriorDecision {
  parentUserId: string;
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
  frequencyPreference: Pick<CadencePreference, 'direction'> | null;
  declines: string[];
  /** Lines the parent who owns every candidate actually sent. Cadence is read from these. */
  recentParentTexts: string[];
  /** New texts past `RECENT_PARENT_TEXTS`, left unread behind the read mark. Absent when none. */
  parentTextsCut?: number;
  /**
   * Why no parent text was read: a teenager's household reads none at all, and a batch
   * two parents own has no one pace to read.
   */
  parentTextsWithheld?: 'teen_household' | 'mixed_batch';
  priorDecisions: PriorDecision[];
}

const WAKING_START = 9 * 60;
const WAKING_END = 20 * 60;
const MIN_WINDOW = 60;
/** The days ahead the decider sees: the calendar, free windows and a clock-less hold. */
export const SNAPSHOT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_PARENT_TEXTS = 5;
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
/** What a calendar entry reads as when its title is not this review's to read. */
const BUSY_LABEL = 'busy';

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
  /** Set on a row from one parent's own connected calendar: whose it is, if anyone's. */
  personal: { userId: string | null } | null;
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

/**
 * A calendar entry as loaded, before the batch's owner is known. `personal` is never
 * handed to the model: `loadFamilySnapshot` reads it and leaves it behind.
 */
export interface LoadedCalendarEntry extends CalendarEntry {
  personal: TimedRow['personal'];
}

/**
 * A line as loaded, before the batch's owner is known: `parentUserId` is whose mailbox
 * the offer came from, or who asked for the watch. Never handed to the model:
 * `loadFamilySnapshot` reads it and leaves it behind.
 */
interface Owned {
  parentUserId: string;
}

export interface LoadedFamilyContext {
  timeZone: string;
  household: HouseholdContext;
  calendar: LoadedCalendarEntry[];
  calendarOmitted: number;
  freeWindows: FreeWindow[];
  deadlines: ({ what: string; at: string } & Owned)[];
  watches: ({ what: string } & Owned)[];
  declines: ({ what: string } & Owned)[];
  /** A child here is 13 or older. */
  teenInHousehold: boolean;
  /** VIL-393 · the family's stored language tag, for the writer. Never a sentence. */
  language?: string | null;
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
    .select({
      timezone: schema.users.timezone,
      areaCoarse: schema.families.areaCoarse,
      language: schema.families.primaryLanguage,
    })
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
      userId: schema.integrations.userId,
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
    if (redactLabels || sensitive) return BUSY_LABEL;
    return boundedLine(title ?? '') || BUSY_LABEL;
  };
  const line = (text: string): string => (redactLabels ? WITHHELD_LABEL : boundedLine(text));
  const rows: TimedRow[] = [
    ...events.map((row) => ({
      label: label(row.title, row.sensitive),
      personal: null,
      startAt: row.startAt,
      endAt: row.endAt,
      allDay: false,
      transparency: row.transparency,
      status: null,
    })),
    ...snapshots.map((row) => ({
      label: label(row.heldTitle, false),
      personal: { userId: row.userId },
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
      parentUserId: schema.emailAlertOffers.parentUserId,
    })
    .from(schema.emailAlertOffers)
    .where(eq(schema.emailAlertOffers.familyId, familyId))
    .limit(DEADLINE_ROWS);
  const watches = await database
    .select({ label: schema.watchedSpots.label, parentUserId: schema.watchedSpots.parentUserId })
    .from(schema.watchedSpots)
    .where(and(eq(schema.watchedSpots.familyId, familyId), isNull(schema.watchedSpots.releasedAt)))
    .limit(WATCH_ROWS);
  return {
    language: zone.language ?? null,
    timeZone,
    household: {
      areaCoarse: zone.areaCoarse,
      childAgesYears: children.map((child) => ageYears(child.dateOfBirth, now)),
    },
    calendar: listed.map((row) => ({ ...entryOf(row, timeZone), personal: row.personal })),
    calendarOmitted: busy.length - listed.length,
    freeWindows: freeWindowsForDays(
      upcomingDayKeys(now, timeZone, SNAPSHOT_DAYS),
      busy.map((row) => blockOf(row, timeZone)),
    ),
    deadlines: offers
      .filter((offer) => offer.resolution === null && offer.expiresAt.getTime() > now.getTime())
      .map((offer) => ({
        what: line(offer.title),
        at: offer.startsAt.toISOString(),
        parentUserId: offer.parentUserId,
      })),
    watches: watches.map((watch) => ({
      what: line(watch.label),
      parentUserId: watch.parentUserId,
    })),
    declines: offers
      .filter((offer) => offer.resolution === 'declined')
      .map((offer) => ({ what: line(offer.title), parentUserId: offer.parentUserId })),
    teenInHousehold: redactLabels,
  };
}

const PROACTIVE_CATEGORIES = [...new Set(Object.values(PROACTIVE_CATEGORY))];

/** The decision audit row a cadence preference is kept on (preference.ts). */
const CADENCE_DECISION_ACTION = 'proactive_cadence_decision';
/** The audit row of a review that made no decision; in shadow it can carry a read mark. */
const CADENCE_SKIPPED_ACTION = 'proactive_cadence_skipped';

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

/**
 * Whose new texts a review read, up to the newest one. The decision keeps it on its audit
 * row, beside its mode, and that parent's next review reads only what came after: a text
 * reaches the decider once per mode. A shadow review reads past the newest mark of either
 * mode. A live review reads past the newest live mark only, since shadow keeps no pace:
 * a request first read in shadow is read once more when live arms, and kept then. Another
 * parent's review and a batch two parents own write none, so neither can move a text out
 * of its author's reach unread. A shadow review whose model call failed or did not parse
 * writes the mark on its skipped row (review.ts): the texts went to the model, and shadow
 * keeps nothing from them. A live one writes none, so a pace request stays unread until a
 * decision that can keep it has read it.
 */
export interface ParentTextsRead {
  parentUserId: string;
  /**
   * The newest text read, as the database stamped it (`TEXT_STAMP`). Not this review's
   * clock: a text stored after the read under an earlier stamp would fall behind that
   * and never be read. Not a JS `Date` either: that drops the microseconds, and the
   * mark would sit below its own text and read it again every hour.
   */
  through: string;
}

const TEXT_STAMP = sql<string>`to_char(${schema.channelMessages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The newest of this one parent's texts a review in this mode need not read again. */
async function textsReadThrough(
  database: Database,
  familyId: string,
  parentUserId: string,
  mode: 'shadow' | 'live',
): Promise<string | null> {
  const [row] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        inArray(schema.auditLog.actionTaken, [CADENCE_DECISION_ACTION, CADENCE_SKIPPED_ACTION]),
        sql`${schema.auditLog.after} -> 'parentTextsRead' ->> 'parentUserId' = ${parentUserId}`,
        mode === 'live' ? sql`${schema.auditLog.after} ->> 'mode' = ${mode}` : undefined,
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(1);
  if (!row) return null;
  return (row.after as { parentTextsRead: ParentTextsRead }).parentTextsRead.through;
}

export interface LoadedSnapshot {
  snapshot: FamilySnapshot;
  /** Who sent the texts in `recentParentTexts`. Never handed to the model. */
  textAuthors: string[];
  /** The owner's new texts this snapshot read. Null when it read none. */
  textsRead: ParentTextsRead | null;
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
    priorDecisions: LoadedPriorDecision[];
    /** The mode this review runs in: a text is read once per mode (`ParentTextsRead`). */
    mode: 'shadow' | 'live';
    now: Date;
  },
): Promise<LoadedSnapshot> {
  const since = new Date(input.now.getTime() - SNAPSHOT_DAYS * DAY_MS);
  const messages = await database
    .select({
      direction: schema.channelMessages.direction,
      category: schema.channelMessages.category,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  const inbound = messages.filter((row) => row.direction === 'in');
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
  const { context } = input;
  const reader = context.teenInHousehold ? null : owner;
  const readThrough =
    reader === null ? null : await textsReadThrough(database, input.familyId, reader, input.mode);
  const unread =
    reader === null
      ? null
      : and(
          eq(schema.channelMessages.familyId, input.familyId),
          eq(schema.channelMessages.parentUserId, reader),
          eq(schema.channelMessages.direction, 'in'),
          isNotNull(schema.channelMessages.body),
          gte(schema.channelMessages.createdAt, since),
          // A text stamped after this review's clock is the next review's.
          lte(schema.channelMessages.createdAt, input.now),
          readThrough === null
            ? undefined
            : sql`${schema.channelMessages.createdAt} > ${readThrough}::timestamptz`,
        );
  const newTexts =
    unread === null
      ? []
      : await database
          .select({
            parentUserId: schema.channelMessages.parentUserId,
            body: schema.channelMessages.body,
            stamp: TEXT_STAMP,
          })
          .from(schema.channelMessages)
          .where(unread)
          .orderBy(desc(schema.channelMessages.createdAt))
          .limit(RECENT_PARENT_TEXTS);
  // The read mark moves to the newest text, so older ones past the bound stay unread
  // behind it: counted (no body leaves the database for them) and named.
  const [unreadCount] =
    unread === null || newTexts.length < RECENT_PARENT_TEXTS
      ? []
      : await database
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.channelMessages)
          .where(unread);
  const textsCut = unreadCount ? unreadCount.count - newTexts.length : 0;
  const [newest] = newTexts;
  const textsRead =
    reader !== null && newest !== undefined
      ? { parentUserId: reader, through: newest.stamp }
      : null;
  const ownLine = (what: string, parentUserId: string): string =>
    parentUserId === owner ? what : WITHHELD_LABEL;
  const shown = newTexts
    .reverse()
    .map((row) => ({ author: row.parentUserId, text: boundedLine(row.body ?? '') }))
    .filter((row) => row.text.length > 0);
  const snapshot: FamilySnapshot = {
    timeZone: context.timeZone,
    now: input.now.toISOString(),
    localNow: formatSnapshotLocalNow(input.now, context.timeZone),
    household: context.household,
    calendar: context.calendar.map(({ personal, ...entry }) =>
      personal === null || (owner !== null && personal.userId === owner)
        ? entry
        : { ...entry, label: BUSY_LABEL },
    ),
    ...(context.calendarOmitted > 0 ? { calendarOmitted: context.calendarOmitted } : {}),
    freeWindows: context.freeWindows,
    deadlines: context.deadlines.map(({ parentUserId, what, at }) => ({
      what: ownLine(what, parentUserId),
      at,
    })),
    watches: context.watches.map(({ parentUserId, what }) => ({
      what: ownLine(what, parentUserId),
    })),
    candidates: input.candidates,
    recentSends,
    unansweredStreak: unansweredStreak(recentSends),
    frequencyPreference: cadence ? { direction: cadence.direction } : null,
    declines: context.declines.map(({ parentUserId, what }) => ownLine(what, parentUserId)),
    recentParentTexts: shown.map((row) => row.text),
    ...(textsCut > 0 ? { parentTextsCut: textsCut } : {}),
    ...(context.teenInHousehold
      ? { parentTextsWithheld: 'teen_household' as const }
      : owner === null
        ? { parentTextsWithheld: 'mixed_batch' as const }
        : {}),
    priorDecisions: input.priorDecisions.map(({ parentUserId, ...prior }) =>
      prior.reason === null || parentUserId === reader
        ? prior
        : { ...prior, reason: WITHHELD_LABEL },
    ),
  };
  return {
    snapshot,
    textAuthors: [...new Set(shown.map((row) => row.author))],
    textsRead,
  };
}
