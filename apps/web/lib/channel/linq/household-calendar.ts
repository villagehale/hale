import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveSendKind,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { linqGroupCoparentEnabled } from './config';
import {
  GROUP_UNNAMED_PARENT,
  groupBothBookedText,
  groupCoverageConflictText,
  groupFollowupText,
  groupHandoffText,
  groupKidEventText,
  groupKidMailText,
} from './group-coparent-copy';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Both parents' calendars, read together, spoken into the claimed Linq group.
 *
 * Kid-related rows may carry a title. Everything else is free/busy only: the
 * title is dropped before the write, and the table CHECK rejects it if a caller
 * forgets. Notices go to the group only when both parents have an active
 * calendar and `LINQ_GROUP_COPARENT=on`.
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
const HANDOFF_MIN_MS = 5 * 24 * 60 * 60 * 1000;
const HANDOFF_MAX_MS = 10 * 24 * 60 * 60 * 1000;
const SLOT_MS = 60 * 60 * 1000;

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

function hasWord(title: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(
    ` ${title} `,
  );
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
  kind: 'kid_event' | 'conflict' | 'both_booked' | 'handoff' | 'followup' | 'mail';
  dedupeKey: string;
  gateKind: Extract<ProactiveSendKind, 'calendar_alert' | 'followup' | 'email_alert'>;
  category: 'calendar_alert' | 'followup' | 'email_alert';
  text: string;
  recipientUserId: string;
  /** Rows to stamp after the send lands. */
  mark: Array<{ integrationId: string; eventId: string; field: 'announced' | 'followup' }>;
}

export function planHouseholdNotices(input: {
  blocks: readonly BusyBlock[];
  parentUserIds: readonly [string, string];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): HouseholdNotice[] {
  const [first, second] = input.parentUserIds;
  const notices: HouseholdNotice[] = [];
  const horizon = input.now.getTime() + LOOKAHEAD_MS;

  for (const block of input.blocks) {
    if (!block.kidRelated || block.announced || !block.title) continue;
    if (!block.start || block.start.getTime() > horizon) continue;
    if (block.start.getTime() < input.now.getTime() - FOLLOWUP_MS) continue;
    const other = otherParent(block.userId, first, second);
    if (!other) continue;
    const when = formatWhen(block.start, input.timeZone, input.language);
    notices.push({
      kind: 'kid_event',
      dedupeKey: `linq-group:kid:${block.eventId}:${block.start.toISOString()}:${block.status}`,
      gateKind: 'calendar_alert',
      category: 'calendar_alert',
      text: groupKidEventText(input.language, {
        title: block.title,
        when,
        cancelled: block.status === 'cancelled',
      }),
      recipientUserId: other,
      mark: [{ integrationId: block.integrationId, eventId: block.eventId, field: 'announced' }],
    });
  }

  const conflict = soonestConflict(input);
  if (conflict) notices.push(conflict);
  const handoff = soonestHandoff(input);
  if (handoff) notices.push(handoff);

  for (const block of input.blocks) {
    if (!block.kidRelated || !block.announced || block.followupSent || !block.title) continue;
    if (block.status === 'cancelled' || !block.end) continue;
    const end = block.end.getTime();
    if (end > input.now.getTime() || end < input.now.getTime() - FOLLOWUP_MS) continue;
    const other = otherParent(block.userId, first, second);
    if (!other) continue;
    notices.push({
      kind: 'followup',
      dedupeKey: `linq-group:followup:${block.eventId}`,
      gateKind: 'followup',
      category: 'followup',
      text: groupFollowupText(input.language, block.title),
      recipientUserId: other,
      mark: [{ integrationId: block.integrationId, eventId: block.eventId, field: 'followup' }],
    });
    break;
  }

  return notices;
}

function otherParent(userId: string, first: string, second: string): string | null {
  if (userId === first) return second;
  if (userId === second) return first;
  return null;
}

function soonestConflict(input: {
  blocks: readonly BusyBlock[];
  parentUserIds: readonly [string, string];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): HouseholdNotice | null {
  const [first, second] = input.parentUserIds;
  const horizon = input.now.getTime() + LOOKAHEAD_MS;
  let best: { block: BusyBlock; other: BusyBlock; at: number } | null = null;
  for (const block of input.blocks) {
    if (!block.kidRelated || !block.title || block.status === 'cancelled') continue;
    if (!block.start || !block.end) continue;
    if (block.start.getTime() < input.now.getTime() || block.start.getTime() > horizon) continue;
    for (const other of input.blocks) {
      if (other.userId === block.userId || other.status === 'cancelled') continue;
      if (!overlaps(block, other)) continue;
      const at = block.start.getTime();
      if (!best || at < best.at) best = { block, other, at };
    }
  }
  if (!best) return null;
  const titleA = best.block.title;
  const titleB = best.other.title;
  if (!titleA) return null;
  const recipient = otherParent(best.block.userId, first, second);
  if (!recipient) return null;
  const when = formatWhen(best.block.start as Date, input.timeZone, input.language);
  const free = earliestSharedFree(input.blocks, input.now, input.timeZone);
  const freeWhen = free ? formatWhen(free, input.timeZone, input.language) : null;
  if (best.other.kidRelated && titleB) {
    return {
      kind: 'both_booked',
      dedupeKey: `linq-group:both:${pairKey(best.block.eventId, best.other.eventId)}`,
      gateKind: 'calendar_alert',
      category: 'calendar_alert',
      text: groupBothBookedText(input.language, {
        titleA,
        titleB,
        when,
        freeWhen,
      }),
      recipientUserId: recipient,
      mark: [],
    };
  }
  return {
    kind: 'conflict',
    dedupeKey: `linq-group:conflict:${pairKey(best.block.eventId, best.other.eventId)}`,
    gateKind: 'calendar_alert',
    category: 'calendar_alert',
    text: groupCoverageConflictText(input.language, {
      title: titleA,
      when,
      freeWhen,
    }),
    recipientUserId: recipient,
    mark: [],
  };
}

function soonestHandoff(input: {
  blocks: readonly BusyBlock[];
  parentUserIds: readonly [string, string];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): HouseholdNotice | null {
  const [first, second] = input.parentUserIds;
  const horizon = input.now.getTime() + LOOKAHEAD_MS;
  const kids = input.blocks.filter(
    (block) =>
      block.kidRelated &&
      block.title &&
      block.status !== 'cancelled' &&
      block.start &&
      block.start.getTime() >= input.now.getTime() &&
      block.start.getTime() <= horizon,
  );
  let best: { earlier: BusyBlock; later: BusyBlock } | null = null;
  for (const earlier of kids) {
    for (const later of kids) {
      if (earlier.userId === later.userId || !earlier.start || !later.start || !earlier.title)
        continue;
      if (normalizeTitle(earlier.title) !== normalizeTitle(later.title ?? '')) continue;
      const gap = later.start.getTime() - earlier.start.getTime();
      if (gap < HANDOFF_MIN_MS || gap > HANDOFF_MAX_MS) continue;
      if (!best || earlier.start.getTime() < (best.earlier.start?.getTime() ?? 0)) {
        best = { earlier, later };
      }
    }
  }
  if (!best?.earlier.title || !best.earlier.start || !best.later.start) return null;
  const recipient = otherParent(best.earlier.userId, first, second);
  if (!recipient) return null;
  return {
    kind: 'handoff',
    dedupeKey: `linq-group:handoff:${normalizeTitle(best.earlier.title)}:${best.later.eventId}`,
    gateKind: 'calendar_alert',
    category: 'calendar_alert',
    text: groupHandoffText(input.language, {
      title: best.earlier.title,
      whenA: formatWhen(best.earlier.start, input.timeZone, input.language),
      whenB: formatWhen(best.later.start, input.timeZone, input.language),
    }),
    recipientUserId: recipient,
    mark: [],
  };
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join(':');
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
  const startDay = zonedParts(now, timeZone);
  for (let day = 0; day < 7; day += 1) {
    const date = addDays(startDay, day);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const fromHour = weekend ? 9 : 15;
    const toHour = weekend ? 12 : 19;
    for (let hour = fromHour; hour < toHour; hour += 1) {
      const slot = dateInZone(timeZone, date.year, date.month, date.day, hour, 0);
      if (slot.getTime() < now.getTime()) continue;
      const slotEnd = slot.getTime() + SLOT_MS;
      const busy = blocks.some((block) => {
        if (block.status === 'cancelled' || !block.start) return false;
        const end = (block.end ?? new Date(block.start.getTime() + 60 * 60 * 1000)).getTime();
        return block.start.getTime() < slotEnd && slot.getTime() < end;
      });
      if (!busy) return slot;
    }
  }
  return null;
}

export function formatWhen(date: Date, timeZone: string, language: ReplyLanguage): string {
  return new Intl.DateTimeFormat(language === 'fr' ? 'fr-CA' : 'en-CA', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
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
    } else if (input.seeding || !input.bothCalendars || !kidRelated) {
      announcedAt = prev?.announcedAt ?? input.now;
    } else if (startChanged || becameCancelled) {
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
  const notices = planHouseholdNotices({
    blocks,
    parentUserIds: context.parentUserIds,
    now: input.now,
    timeZone: context.timeZone,
    language: context.language,
  });
  for (const notice of notices) {
    const sent = await sendGroupNotice(database, {
      familyId: input.familyId,
      chatId: context.chatId,
      notice,
      now: input.now,
      fetch: input.fetch,
    });
    if (sent !== 'sent') continue;
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
}

/**
 * Kid-related mailbox subjects only. A subject the classifier rejects is not
 * returned and is not written anywhere by this function.
 */
export async function narrateHouseholdMailbox(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    envelopes: readonly { messageId: string; subject: string }[];
    /** A first sync is the mailbox's existing mail. It is not news. */
    seeding?: boolean;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<void> {
  if (!linqGroupCoparentEnabled() || input.seeding) return;
  const context = await loadFamilyCalendarContext(database, input.familyId);
  if (!context.bothMailboxes || !context.parentUserIds || !context.chatId) return;
  const recipient = otherParent(input.userId, context.parentUserIds[0], context.parentUserIds[1]);
  if (!recipient) return;
  const [speaker] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  const name = speaker?.name?.trim() || GROUP_UNNAMED_PARENT[context.language];
  for (const envelope of input.envelopes) {
    const subject = kidMailboxSubject({
      subject: envelope.subject,
      childNames: context.childNames,
    });
    if (!subject) continue;
    await sendGroupNotice(database, {
      familyId: input.familyId,
      chatId: context.chatId,
      now: input.now,
      fetch: input.fetch,
      notice: {
        kind: 'mail',
        dedupeKey: `linq-group:mail:${envelope.messageId}`,
        gateKind: 'email_alert',
        category: 'email_alert',
        text: groupKidMailText(context.language, { name, subject }),
        recipientUserId: recipient,
        mark: [],
      },
    });
  }
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
      actionTaken:
        input.notice.category === 'followup'
          ? 'sms_reply_sent'
          : input.notice.category === 'email_alert'
            ? 'email_alert_sent'
            : 'calendar_alert_sent',
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
