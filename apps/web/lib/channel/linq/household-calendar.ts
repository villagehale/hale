import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { SENT_STATUSES, acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { linqGroupCoparentEnabled } from './config';
import {
  groupBothFreeText,
  groupConflictText,
  groupHandoffText,
  groupKidEventText,
  groupPostEventText,
} from './group-coparent-copy';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Both parents' calendars, read together, spoken into the claimed Linq group.
 *
 * Kid-related rows may carry a title. Everything else is free/busy only: the
 * title is dropped before the write, and the table CHECK rejects it if a caller
 * forgets. Notices go to the group only when both parents have an active
 * calendar. The Linq flag defaults on; `LINQ_GROUP_COPARENT=off` is the kill
 * switch. Mail is never spoken here.
 *
 * Proactive group speech is one bubble: at most one a day and three a week,
 * never during quiet hours. A cancellation, a weekly recap, and an unprompted
 * both-free suggestion are not bubbles.
 */

const KID_WORDS = [
  'gymnastics',
  'swim',
  'swimming',
  'soccer',
  'daycare',
  'school',
  'pickup',
  'pick-up',
  'registration',
  'appointment',
  'class',
  'lesson',
  'practice',
  'recital',
  'camp',
  'storytime',
  'earlyon',
  'preschool',
  'nursery',
  'pediatric',
  'ballet',
  'karate',
  'hockey',
  'piano',
  'tutor',
] as const;

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const FOLLOWUP_MS = 36 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const SLOT_MS = 60 * 60 * 1000;
const KID_LINES_MAX = 3;
const GROUP_DAY_MAX = 1;
const GROUP_WEEK_MAX = 3;
/** Evening before quiet hours (21:00). Local hour is in [17, 21). */
const HANDOFF_HOUR_START = 17;
const HANDOFF_HOUR_END = 21;

const GROUP_PROACTIVE_TEMPLATES = [
  'linq:group_kid_event',
  'linq:group_conflict',
  'linq:group_handoff',
  'linq:group_followup',
] as const;

/** A parent said who takes it. Not a guess from two calendars. */
const HANDOFF_CLAIM =
  /\b(?:i(?:['’]ll| will) take|i(?:['’]ve| have) got|je m(?:['’]en|en) occupe|c(?:['’]est|est) moi)\b/i;

export function classifyKidCalendarItem(input: {
  title: string | null | undefined;
  childNames: readonly string[];
}): boolean {
  const title = input.title?.trim() ?? '';
  if (title.length === 0) return false;
  for (const name of input.childNames) {
    const token = name.trim();
    if (token.length < 2) continue;
    if (hasWord(title, token)) return true;
  }
  return KID_WORDS.some((word) => hasWord(title, word));
}

/** Title column value. Null unless the row is kid-related. */
export function titleForStorage(
  kidRelated: boolean,
  title: string | null | undefined,
): string | null {
  if (!kidRelated) return null;
  const trimmed = title?.replace(/\s+/g, ' ').trim() ?? '';
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 80);
}

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu');
}

function hasWord(title: string, word: string): boolean {
  return wordPattern(word).test(` ${title} `);
}

export interface BusyBlock {
  integrationId: string;
  userId: string;
  eventId: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  kidRelated: boolean;
  title: string | null;
  status: string;
  announced: boolean;
  followupSent: boolean;
  recurringEventId: string | null;
}

export interface HouseholdNotice {
  kind: 'kid_event' | 'conflict' | 'handoff' | 'followup';
  dedupeKey: string;
  /**
   * `activity_followup` has no frequency counter, so an SMS calendar alert
   * cannot eat the group's own 1/day and 3/week cap. Quiet hours and consent
   * still apply. The group's cap is counted on the template keys below.
   */
  gateKind: 'activity_followup';
  category: 'calendar_alert' | 'followup';
  text: string;
  recipientUserId: string;
  /** Rows to stamp after the send lands. */
  mark: Array<{ integrationId: string; eventId: string; field: 'announced' | 'followup' }>;
}

export interface HandoffStatement {
  userId: string;
  text: string;
}

export interface NoticePlanInput {
  blocks: readonly BusyBlock[];
  parentUserIds: readonly [string, string];
  parentNames: Readonly<Record<string, string>>;
  childNames: readonly string[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
  /** Something a parent said in the group. Never inferred from turn-taking. */
  statements?: readonly HandoffStatement[];
}

/**
 * At most one bubble. Conflict, then an evening-before handoff, then up to
 * three new kid-event lines, then one how-it-went. Anything else is omitted.
 */
export function planHouseholdNotices(input: NoticePlanInput): HouseholdNotice[] {
  // A named handoff the evening before beats "who's taking it?": someone
  // already said, or the event is on exactly one calendar.
  const handoff = soonestHandoff(input);
  if (handoff) return [handoff];
  const conflict = soonestConflict(input);
  if (conflict) return [conflict];
  const kids = batchedKidEvents(input);
  if (kids) return [kids];
  const followup = soonestFollowup(input);
  return followup ? [followup] : [];
}

function otherParent(userId: string, first: string, second: string): string | null {
  if (userId === first) return second;
  if (userId === second) return first;
  return null;
}

function upcomingKid(block: BusyBlock, now: Date): boolean {
  if (!block.kidRelated || !block.title || block.status === 'cancelled' || !block.start)
    return false;
  if (block.start.getTime() < now.getTime() - FOLLOWUP_MS) return false;
  return block.start.getTime() <= now.getTime() + LOOKAHEAD_MS;
}

function soonestConflict(input: NoticePlanInput): HouseholdNotice | null {
  const [first, second] = input.parentUserIds;
  let best: { block: BusyBlock; at: number } | null = null;
  for (const block of input.blocks) {
    if (!upcomingKid(block, input.now) || !block.start || !block.end) continue;
    if (block.start.getTime() < input.now.getTime()) continue;
    const busy = input.blocks.some(
      (other) =>
        other.userId !== block.userId && other.status !== 'cancelled' && overlaps(block, other),
    );
    if (!busy) continue;
    const at = block.start.getTime();
    if (!best || at < best.at) best = { block, at };
  }
  if (!best?.block.title || !best.block.start) return null;
  const parts = splitKidEvent(best.block.title, input.childNames);
  const recipient = otherParent(best.block.userId, first, second);
  if (!parts || !recipient) return null;
  return {
    kind: 'conflict',
    dedupeKey: `linq-group:conflict:${best.block.eventId}:${best.block.start.toISOString()}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    text: groupConflictText(input.language, {
      kid: parts.kid,
      event: parts.event,
      day: formatDay(best.block.start, input.timeZone, input.language),
      time: formatTime(best.block.start, input.timeZone, input.language),
    }),
    recipientUserId: recipient,
    mark: [
      {
        integrationId: best.block.integrationId,
        eventId: best.block.eventId,
        field: 'announced',
      },
    ],
  };
}

function soonestHandoff(input: NoticePlanInput): HouseholdNotice | null {
  const hour = zonedClock(input.now, input.timeZone).hour;
  if (hour < HANDOFF_HOUR_START || hour >= HANDOFF_HOUR_END) return null;
  const [first, second] = input.parentUserIds;
  const tomorrow = addDays(zonedParts(input.now, input.timeZone), 1);
  let best: BusyBlock | null = null;
  let ownerId: string | null = null;
  for (const block of input.blocks) {
    if (!upcomingKid(block, input.now) || !block.start || !block.title) continue;
    const local = zonedParts(block.start, input.timeZone);
    if (
      local.year !== tomorrow.year ||
      local.month !== tomorrow.month ||
      local.day !== tomorrow.day
    ) {
      continue;
    }
    const stated = statedOwner(block, input.statements ?? [], input.blocks);
    const sole = soleCalendarOwner(block, input.blocks);
    const owner = stated ?? sole;
    if (!owner) continue;
    if (!best || block.start.getTime() < (best.start?.getTime() ?? 0)) {
      best = block;
      ownerId = owner;
    }
  }
  if (!best?.title || !best.start || !ownerId) return null;
  const name = input.parentNames[ownerId]?.trim();
  const parts = splitKidEvent(best.title, input.childNames);
  const recipient = otherParent(ownerId, first, second) ?? ownerId;
  if (!name || !parts) return null;
  return {
    kind: 'handoff',
    dedupeKey: `linq-group:handoff:${best.eventId}:${best.start.toISOString()}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    text: groupHandoffText(input.language, {
      name,
      kid: parts.kid,
      event: parts.event,
      time: formatTime(best.start, input.timeZone, input.language),
    }),
    recipientUserId: recipient,
    mark: [{ integrationId: best.integrationId, eventId: best.eventId, field: 'announced' }],
  };
}

function batchedKidEvents(input: NoticePlanInput): HouseholdNotice | null {
  const [first, second] = input.parentUserIds;
  const fresh = input.blocks
    .filter((block) => upcomingKid(block, input.now) && !block.announced && block.start)
    .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  const lines: string[] = [];
  const mark: HouseholdNotice['mark'] = [];
  const ids: string[] = [];
  let recipient: string | null = null;
  for (const block of fresh) {
    if (lines.length >= KID_LINES_MAX) break;
    if (!block.title || !block.start) continue;
    const parts = splitKidEvent(block.title, input.childNames);
    const name = input.parentNames[block.userId]?.trim();
    const other = otherParent(block.userId, first, second);
    if (!parts || !name || !other) continue;
    lines.push(
      groupKidEventText(input.language, {
        name,
        kid: parts.kid,
        event: parts.event,
        day: formatDay(block.start, input.timeZone, input.language),
        time: formatTime(block.start, input.timeZone, input.language),
      }),
    );
    mark.push({ integrationId: block.integrationId, eventId: block.eventId, field: 'announced' });
    ids.push(block.eventId);
    recipient ??= other;
  }
  if (lines.length === 0 || !recipient) return null;
  return {
    kind: 'kid_event',
    dedupeKey: `linq-group:kids:${ids.join(':')}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    text: lines.join('\n'),
    recipientUserId: recipient,
    mark,
  };
}

function soonestFollowup(input: NoticePlanInput): HouseholdNotice | null {
  let best: { block: BusyBlock; ownerId: string } | null = null;
  for (const block of input.blocks) {
    if (!block.kidRelated || !block.announced || block.followupSent || !block.title) continue;
    if (block.status === 'cancelled' || !block.end) continue;
    const end = block.end.getTime();
    if (end > input.now.getTime() || end < input.now.getTime() - FOLLOWUP_MS) continue;
    const stated = statedOwner(block, input.statements ?? [], input.blocks);
    const sole = soleCalendarOwner(block, input.blocks);
    const owner = stated ?? sole;
    if (!owner) continue;
    if (!best || end > (best.block.end?.getTime() ?? 0)) best = { block, ownerId: owner };
  }
  if (!best?.block.title) return null;
  const name = input.parentNames[best.ownerId]?.trim();
  const parts = splitKidEvent(best.block.title, input.childNames);
  if (!name || !parts) return null;
  return {
    kind: 'followup',
    dedupeKey: `linq-group:followup:${best.block.eventId}`,
    gateKind: 'activity_followup',
    category: 'followup',
    text: groupPostEventText(input.language, name, parts.event),
    recipientUserId: best.ownerId,
    mark: [
      { integrationId: best.block.integrationId, eventId: best.block.eventId, field: 'followup' },
    ],
  };
}

/** The parent who said they take this event, when the words name it or it is the only one. */
function statedOwner(
  block: BusyBlock,
  statements: readonly HandoffStatement[],
  blocks: readonly BusyBlock[],
): string | null {
  if (!block.title) return null;
  const title = normalizeTitle(block.title);
  const claimants = statements.filter((statement) => HANDOFF_CLAIM.test(statement.text));
  if (claimants.length === 0) return null;
  const named = claimants.find((statement) => normalizeTitle(statement.text).includes(title));
  if (named) return named.userId;
  const open = blocks.filter(
    (row) => row.kidRelated && row.title && row.status !== 'cancelled' && row.start,
  );
  if (open.length === 1 && open[0]?.eventId === block.eventId) return claimants[0]?.userId ?? null;
  return null;
}

/** The event lives on exactly one parent's calendar. Two copies are not a handoff. */
function soleCalendarOwner(block: BusyBlock, blocks: readonly BusyBlock[]): string | null {
  if (!block.title) return null;
  const title = normalizeTitle(block.title);
  const holders = new Set(
    blocks
      .filter(
        (row) =>
          row.kidRelated &&
          row.title &&
          row.status !== 'cancelled' &&
          normalizeTitle(row.title) === title &&
          overlaps(block, row),
      )
      .map((row) => row.userId),
  );
  if (holders.size !== 1) return null;
  return holders.values().next().value ?? null;
}

export function splitKidEvent(
  title: string,
  childNames: readonly string[],
): { kid: string; event: string } | null {
  const names = childNames
    .map((name) => name.trim())
    .filter((name) => name.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (!hasWord(title, name)) continue;
    const event = title
      .replace(wordPattern(name), ' ')
      .replace(/^['’]?s\b/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!event) return null;
    return { kid: name, event };
  }
  if (names.length === 1) return { kid: names[0] as string, event: title.trim() };
  return null;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function overlaps(a: BusyBlock, b: BusyBlock): boolean {
  const aStart = a.start?.getTime();
  const bStart = b.start?.getTime();
  if (aStart === undefined || bStart === undefined) return false;
  const aEnd = (a.end ?? new Date(aStart + (a.allDay ? 24 : 1) * 60 * 60 * 1000)).getTime();
  const bEnd = (b.end ?? new Date(bStart + (b.allDay ? 24 : 1) * 60 * 60 * 1000)).getTime();
  return aStart < bEnd && bStart < aEnd;
}

/** Earliest 60-minute waking slot in the next 7 days when neither parent is busy. */
export function earliestSharedFree(
  blocks: readonly BusyBlock[],
  now: Date,
  timeZone: string,
): Date | null {
  return sharedFreeSlots(blocks, now, timeZone, 1)[0] ?? null;
}

/** Up to `count` shared free hours. Used only when a parent asked, or a find needs a time. */
export function sharedFreeSlots(
  blocks: readonly BusyBlock[],
  now: Date,
  timeZone: string,
  count: number,
): Date[] {
  const found: Date[] = [];
  const startDay = zonedParts(now, timeZone);
  for (let day = 0; day < 7 && found.length < count; day += 1) {
    const date = addDays(startDay, day);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const fromHour = weekend ? 9 : 15;
    const toHour = weekend ? 12 : 19;
    for (let hour = fromHour; hour < toHour && found.length < count; hour += 1) {
      const slot = dateInZone(timeZone, date.year, date.month, date.day, hour, 0);
      if (slot.getTime() < now.getTime()) continue;
      const slotEnd = slot.getTime() + SLOT_MS;
      const busy = blocks.some((block) => {
        if (block.status === 'cancelled' || !block.start) return false;
        const end = (block.end ?? new Date(block.start.getTime() + 60 * 60 * 1000)).getTime();
        return block.start.getTime() < slotEnd && slot.getTime() < end;
      });
      if (!busy) found.push(slot);
    }
  }
  return found;
}

/**
 * Both-free copy. `requested` must be true: a calendar sweep never sets it.
 * Returns null when fewer than two shared hours exist. Hale does not book.
 */
export function proposeSharedFree(input: {
  requested: boolean;
  blocks: readonly BusyBlock[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): string | null {
  if (!input.requested) return null;
  const slots = sharedFreeSlots(input.blocks, input.now, input.timeZone, 2);
  const first = slots[0];
  const second = slots[1];
  if (!first || !second) return null;
  const phrase = (slot: Date) =>
    `${formatDay(slot, input.timeZone, input.language)} ${formatTime(slot, input.timeZone, input.language)}`;
  return groupBothFreeText(input.language, phrase(first), phrase(second));
}

export function formatDay(date: Date, timeZone: string, language: ReplyLanguage): string {
  return new Intl.DateTimeFormat(language === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatTime(date: Date, timeZone: string, language: ReplyLanguage): string {
  return new Intl.DateTimeFormat(language === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function formatWhen(date: Date, timeZone: string, language: ReplyLanguage): string {
  return `${formatDay(date, timeZone, language)} ${formatTime(date, timeZone, language)}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function addDays(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function dateInZone(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 2; i += 1) {
    const got = zonedClock(guess, timeZone);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    const have = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
    guess = new Date(guess.getTime() + (wanted - have));
  }
  return guess;
}

function zonedClock(date: Date, timeZone: string): ZonedParts & { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

/** A mailbox subject may be said in the group only when it is kid-related.
 * The sender address is not an input: it cannot appear in the result. */
export function kidMailboxSubject(input: {
  subject: string;
  childNames: readonly string[];
}): string | null {
  const subject = input.subject.replace(/\s+/g, ' ').trim();
  if (subject.length === 0 || subject.includes('@')) return null;
  if (!classifyKidCalendarItem({ title: subject, childNames: input.childNames })) return null;
  return subject.slice(0, 80);
}

interface ChangeStamp {
  start: Date | null;
  end: Date | null;
  allDay: boolean;
}

function changeStamp(change: CalendarChange): ChangeStamp {
  const allDay = Boolean(change.start.date && !change.start.dateTime);
  return {
    allDay,
    start: parseGoogleWhen(change.start.dateTime ?? change.start.date ?? null, allDay),
    end: parseGoogleWhen(change.end?.dateTime ?? change.end?.date ?? null, allDay),
  };
}

function parseGoogleWhen(value: string | null, allDay: boolean): Date | null {
  if (!value) return null;
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Remember one connection's calendar changes. Titles of non-kid events are not
 * written. Returns nothing the caller has to send; {@link narrateHouseholdCalendar}
 * does that for the whole family.
 */
export async function rememberCalendarChanges(
  database: Database,
  input: {
    integrationId: string;
    familyId: string;
    userId: string;
    changes: readonly CalendarChange[];
    childNames: readonly string[];
    seeding: boolean;
    bothCalendars: boolean;
    now: Date;
  },
): Promise<void> {
  for (const change of input.changes) {
    const stamp = changeStamp(change);
    const kidRelated = classifyKidCalendarItem({
      title: change.title,
      childNames: input.childNames,
    });
    const title = titleForStorage(kidRelated, change.title);
    const [prev] = await database
      .select({
        startAt: schema.parentCalendarBlocks.startAt,
        status: schema.parentCalendarBlocks.status,
        announcedAt: schema.parentCalendarBlocks.announcedAt,
        followupAt: schema.parentCalendarBlocks.followupAt,
      })
      .from(schema.parentCalendarBlocks)
      .where(
        and(
          eq(schema.parentCalendarBlocks.integrationId, input.integrationId),
          eq(schema.parentCalendarBlocks.eventId, change.eventId),
        ),
      )
      .limit(1);
    const startChanged =
      prev !== undefined && (prev.startAt?.getTime() ?? null) !== (stamp.start?.getTime() ?? null);
    const becameCancelled = change.status === 'cancelled' && prev?.status !== 'cancelled';
    let announcedAt: Date | null;
    if (
      !prev &&
      (input.seeding || !input.bothCalendars || !kidRelated || change.status === 'cancelled')
    ) {
      announcedAt = input.now;
    } else if (input.seeding || !input.bothCalendars || !kidRelated || becameCancelled) {
      // A cancellation is not a group nudge. Stamp it so it is not retried.
      announcedAt = prev?.announcedAt ?? input.now;
    } else if (startChanged) {
      announcedAt = null;
    } else {
      announcedAt = prev?.announcedAt ?? null;
    }
    const followupAt = startChanged ? null : (prev?.followupAt ?? null);
    await database
      .insert(schema.parentCalendarBlocks)
      .values({
        integrationId: input.integrationId,
        eventId: change.eventId,
        familyId: input.familyId,
        userId: input.userId,
        startAt: stamp.start,
        endAt: stamp.end,
        allDay: stamp.allDay,
        kidRelated,
        title,
        recurringEventId: change.recurringEventId ?? null,
        status: change.status,
        updatedStamp: change.updated,
        announcedAt,
        followupAt,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [schema.parentCalendarBlocks.integrationId, schema.parentCalendarBlocks.eventId],
        set: {
          startAt: stamp.start,
          endAt: stamp.end,
          allDay: stamp.allDay,
          kidRelated,
          title,
          recurringEventId: change.recurringEventId ?? null,
          status: change.status,
          updatedStamp: change.updated,
          announcedAt,
          followupAt,
          updatedAt: input.now,
        },
      });
  }
}

async function loadFamilyCalendarContext(
  database: Database,
  familyId: string,
): Promise<{
  parentUserIds: readonly [string, string] | null;
  bothCalendars: boolean;
  bothMailboxes: boolean;
  timeZone: string;
  language: ReplyLanguage;
  chatId: string | null;
  childNames: string[];
}> {
  const members = await database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const parents = members.filter(
    (row) => row.role === 'primary_parent' || row.role === 'co_parent',
  );
  const [family] = await database
    .select({
      linqGroupChatId: schema.families.linqGroupChatId,
      primaryLanguage: schema.families.primaryLanguage,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const primary = parents.find((row) => row.role === 'primary_parent');
  const [zone] = primary
    ? await database
        .select({ timezone: schema.users.timezone })
        .from(schema.users)
        .where(eq(schema.users.id, primary.userId))
        .limit(1)
    : [];
  const connections = await database
    .select({
      userId: schema.integrations.userId,
      provider: schema.integrations.provider,
      status: schema.integrations.status,
    })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, familyId));
  const active = connections.filter(
    (row) => row.userId && (row.status === 'active' || row.status === 'error'),
  );
  const gcal = new Set(active.filter((row) => row.provider === 'gcal').map((row) => row.userId));
  const gmail = new Set(active.filter((row) => row.provider === 'gmail').map((row) => row.userId));
  const children = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const pair = parents.length >= 2 ? ([parents[0]?.userId, parents[1]?.userId] as const) : null;
  const parentUserIds = pair?.[0] && pair[1] ? ([pair[0], pair[1]] as const) : null;
  return {
    parentUserIds,
    bothCalendars: gcal.size >= 2,
    bothMailboxes: gmail.size >= 2,
    timeZone: zone?.timezone ?? 'America/Toronto',
    language: family?.primaryLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    chatId: family?.linqGroupChatId ?? null,
    childNames: children.map((row) => row.name),
  };
}

export async function narrateHouseholdCalendar(
  database: Database,
  input: {
    familyId: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<void> {
  if (!linqGroupCoparentEnabled()) return;
  const context = await loadFamilyCalendarContext(database, input.familyId);
  if (!context.bothCalendars || !context.parentUserIds || !context.chatId) return;
  const rows = await database
    .select()
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, input.familyId));
  const blocks: BusyBlock[] = rows.map((row) => ({
    integrationId: row.integrationId,
    userId: row.userId,
    eventId: row.eventId,
    start: row.startAt,
    end: row.endAt,
    allDay: row.allDay,
    kidRelated: row.kidRelated,
    title: row.title,
    status: row.status,
    announced: row.announcedAt !== null,
    followupSent: row.followupAt !== null,
    recurringEventId: row.recurringEventId,
  }));
  const names = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, [...context.parentUserIds]));
  const parentNames: Record<string, string> = {};
  for (const row of names) {
    if (row.name) parentNames[row.id] = row.name;
  }
  const statements = await loadHandoffStatements(
    database,
    input.familyId,
    context.chatId,
    input.now,
  );
  const notices = planHouseholdNotices({
    blocks,
    parentUserIds: context.parentUserIds,
    parentNames,
    childNames: context.childNames,
    now: input.now,
    timeZone: context.timeZone,
    language: context.language,
    statements,
  });
  const notice = notices[0];
  if (!notice) return;
  if (await groupCapReached(database, input.familyId, input.now)) {
    console.warn({ familyId: input.familyId }, 'household calendar: group cap reached');
    return;
  }
  const sent = await sendGroupNotice(database, {
    familyId: input.familyId,
    chatId: context.chatId,
    notice,
    now: input.now,
    fetch: input.fetch,
  });
  if (sent !== 'sent') return;
  for (const mark of notice.mark) {
    await database
      .update(schema.parentCalendarBlocks)
      .set(
        mark.field === 'announced'
          ? { announcedAt: input.now, updatedAt: input.now }
          : { followupAt: input.now, updatedAt: input.now },
      )
      .where(
        and(
          eq(schema.parentCalendarBlocks.integrationId, mark.integrationId),
          eq(schema.parentCalendarBlocks.eventId, mark.eventId),
        ),
      );
  }
}

async function groupCapReached(database: Database, familyId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - WEEK_MS);
  const rows = await database
    .select({
      createdAt: schema.channelMessages.createdAt,
      status: schema.channelMessages.status,
      templateKey: schema.channelMessages.templateKey,
      familyId: schema.channelMessages.familyId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        inArray(schema.channelMessages.templateKey, [...GROUP_PROACTIVE_TEMPLATES]),
        gte(schema.channelMessages.createdAt, since),
      ),
    );
  const sent = rows.filter(
    (row) =>
      row.familyId === familyId &&
      row.templateKey !== null &&
      (GROUP_PROACTIVE_TEMPLATES as readonly string[]).includes(row.templateKey) &&
      (SENT_STATUSES as readonly string[]).includes(row.status) &&
      row.createdAt.getTime() >= since.getTime(),
  );
  const dayAgo = now.getTime() - DAY_MS;
  const today = sent.filter((row) => row.createdAt.getTime() >= dayAgo).length;
  return today >= GROUP_DAY_MAX || sent.length >= GROUP_WEEK_MAX;
}

async function loadHandoffStatements(
  database: Database,
  familyId: string,
  chatId: string,
  now: Date,
): Promise<HandoffStatement[]> {
  const since = new Date(now.getTime() - 2 * DAY_MS);
  const rows = await database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      body: schema.channelMessages.body,
      familyId: schema.channelMessages.familyId,
      providerChatId: schema.channelMessages.providerChatId,
      direction: schema.channelMessages.direction,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.providerChatId, chatId),
        eq(schema.channelMessages.direction, 'in'),
      ),
    );
  return rows
    .filter(
      (row) =>
        row.familyId === familyId &&
        row.providerChatId === chatId &&
        row.direction === 'in' &&
        row.parentUserId &&
        row.body &&
        row.createdAt.getTime() >= since.getTime(),
    )
    .map((row) => ({ userId: row.parentUserId as string, text: row.body as string }));
}

/**
 * Mail stays out of the group. Subjects, senders, and snippets are not
 * spoken here. The owner's existing SMS email alert is a different path.
 * The return is named so a caller can see the suppression.
 */
export async function narrateHouseholdMailbox(
  _database: Database,
  input: {
    familyId: string;
    userId: string;
    envelopes: readonly { messageId: string; subject: string }[];
    /** A first sync is the mailbox's existing mail. It is not news. */
    seeding?: boolean;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<{ suppressed: 'mail_not_in_group' }> {
  console.info(
    {
      familyId: input.familyId,
      envelopes: input.envelopes.length,
      seeding: input.seeding === true,
    },
    'household mailbox: group speech suppressed',
  );
  return { suppressed: 'mail_not_in_group' };
}

async function sendGroupNotice(
  database: Database,
  input: {
    familyId: string;
    chatId: string;
    notice: HouseholdNotice;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<'sent' | 'already_sent' | 'held' | 'not_sent'> {
  if (await dedupeActive(input.notice.dedupeKey, database)) return 'already_sent';
  const verdict = await assertProactiveSendAllowed(
    {
      familyId: input.familyId,
      parentUserId: input.notice.recipientUserId,
      kind: input.notice.gateKind,
      now: input.now,
    },
    buildOutboundGatePorts(database),
  );
  if (!verdict.allowed) {
    console.warn(
      { familyId: input.familyId, kind: input.notice.kind, reason: verdict.reason },
      'household calendar: group notice held',
    );
    return 'held';
  }
  const body = withOptOut(input.notice.text, verdict.optOut);
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.notice.recipientUserId,
      channel: 'imessage',
      direction: 'out',
      category: input.notice.category,
      templateKey: `linq:group_${input.notice.kind}`,
      dedupeKey: input.notice.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return 'already_sent';
  try {
    const sent = await sendLinqChatMessage({
      chatId: input.chatId,
      text: body,
      fetch: input.fetch,
    });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: input.notice.category === 'followup' ? 'sms_reply_sent' : 'calendar_alert_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { kind: input.notice.kind },
    });
    return 'sent';
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn(
      { familyId: input.familyId, code },
      'household calendar: group notice did not land',
    );
    return 'not_sent';
  }
}

/** A parent asked, or a live find needs a time. Never called from the sweep. */
export async function answerBothFreeInGroup(
  database: Database,
  input: { familyId: string; now: Date; language: ReplyLanguage },
): Promise<string | null> {
  const context = await loadFamilyCalendarContext(database, input.familyId);
  const rows = await database
    .select()
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, input.familyId));
  const blocks: BusyBlock[] = rows
    .filter((row) => row.familyId === input.familyId)
    .map((row) => ({
      integrationId: row.integrationId,
      userId: row.userId,
      eventId: row.eventId,
      start: row.startAt,
      end: row.endAt,
      allDay: row.allDay,
      kidRelated: row.kidRelated,
      title: row.title,
      status: row.status,
      announced: row.announcedAt !== null,
      followupSent: row.followupAt !== null,
      recurringEventId: row.recurringEventId,
    }));
  return proposeSharedFree({
    requested: true,
    blocks,
    now: input.now,
    timeZone: context.timeZone,
    language: input.language,
  });
}

export async function familyHasTwoCalendars(
  database: Database,
  familyId: string,
): Promise<boolean> {
  const context = await loadFamilyCalendarContext(database, familyId);
  return context.bothCalendars;
}

/** Used by the connector sweep. Failures stay inside the caller. */
export async function rememberAndNarrateCalendar(
  database: Database,
  input: {
    integrationId: string;
    familyId: string;
    userId: string | null;
    changes: readonly CalendarChange[];
    seeding: boolean;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<void> {
  if (!linqGroupCoparentEnabled() || !input.userId) return;
  const context = await loadFamilyCalendarContext(database, input.familyId);
  await rememberCalendarChanges(database, {
    integrationId: input.integrationId,
    familyId: input.familyId,
    userId: input.userId,
    changes: input.changes,
    childNames: context.childNames,
    seeding: input.seeding,
    bothCalendars: context.bothCalendars,
    now: input.now,
  });
  await narrateHouseholdCalendar(database, {
    familyId: input.familyId,
    now: input.now,
    fetch: input.fetch,
  });
}
