import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { type ReplyLanguage, localeFor } from '~/lib/channel/language';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type ContentClass, teenChildIds } from '~/lib/channel/role-scope';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import {
  linqGroupConflictAlertsEnabled,
  linqGroupCoparentEnabled,
  linqPollsEnabled,
} from './config';
import { groupAudienceAllows } from './group-audience';
import {
  type ClashBusy,
  type ClashPerson,
  type ClashPlan,
  type GroupClash,
  clashCalendar,
  clashPollOffer,
  clashPollOptions,
  findGroupClashes,
  groupConflictLineInput,
  watchedPlan,
} from './group-conflict';
import { sharedGroupConflictWriter } from './group-conflict-voice';
import {
  type GroupPickupClaimReader,
  pickupCandidates,
  pickupClaimAction,
  pickupDecisionKey,
} from './group-pickup-claim';
import { sharedGroupPickupClaimReader } from './group-pickup-claim-reader';
import { groupTurnReadContext } from './group-turn-reader';
import {
  classifyKidCalendarItem,
  splitKidEvent,
  titleForStorage,
  withoutTeenTitles,
} from './kid-event';

export { classifyKidCalendarItem, splitKidEvent, titleForStorage };
import { sendLinqChatMessage } from '~/lib/channel/outbound-transport';
import {
  groupBothFreeText,
  groupConflictText,
  groupHandoffText,
  groupKidEventText,
  groupPostEventText,
} from './group-coparent-copy';
import {
  type LogisticsSlot,
  type RememberedLogistics,
  bothFreeDay,
  bothFreeFactKey,
  bothFreePollOptions,
  bothFreePrompt,
  isFigureItOutLine,
  loadRememberedLogistics,
  readSlotReply,
  readWhoTakesReply,
  rememberedWhoTakes,
  whoTakesChangedSince,
  whoTakesFactKey,
  whoTakesPollOptions,
  whoTakesPrompt,
  withholdWhoTakes,
  writeLogisticsDecision,
} from './logistics-poll';
import { type PollOptionWrite, sendChoicePoll } from './poll';
import { LinqSendError } from './transport';

/**
 * Both parents' calendars, read together, spoken into the claimed Linq group.
 *
 * Kid-related rows may carry a title. Everything else is free/busy only: the
 * title is dropped before the write, and the table CHECK rejects it if a caller
 * forgets. A claimed group hears kid dates from whichever calendars are
 * connected. Conflict and handoff still need two parents' blocks. The Linq
 * flag defaults on; `LINQ_GROUP_COPARENT=off` is the kill switch. Mail is
 * never spoken here.
 *
 * Proactive group speech is one bubble per pass, chosen by priority. Quiet
 * hours still hold on the send. A daily or weekly count is not a hold. A
 * cancellation, a weekly recap, and an unprompted
 * both-free suggestion are not bubbles.
 *
 * VIL-377, Design locked 2026-09-26: when LINQ_POLLS is on, a conflict is the
 * who-takes prompt alone, then the poll. The locked conflict sentence is not
 * sent on that turn. The prompt carries day and time. The poll ledger row
 * does not spend a second discretionary bubble. An evening event with no
 * taker and no conflict uses that same prompt. Flag off keeps the locked
 * conflict text and does not poll. "We'll figure it out" stores no taker
 * and does not ask again that day.
 *
 * VIL-444: with LINQ_GROUP_CONFLICT_ALERTS_ENABLED the model-written clash alert takes
 * the conflict's turn. With LINQ_POLLS on it may carry the who-takes poll after it: the
 * names as stored, the last option the model's. A vote is stored as the who-takes
 * decision, and the clash planner reads it the way it reads a claim.
 *
 * Kid-event, conflict, handoff, and post-event notices leave only through the
 * family's `linq_group_chat_id`. A Linq refusal is `not_sent`. Nothing on this
 * path sends SMS, and a failed group send is not retried as a 1:1.
 */

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const FOLLOWUP_MS = 36 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MS = 60 * 60 * 1000;
const KID_LINES_MAX = 3;
/** Evening before quiet hours (21:00). Local hour is in [17, 21). */
const HANDOFF_HOUR_START = 17;
const HANDOFF_HOUR_END = 21;

/** A parent said who takes it. Not a guess from two calendars. */
const HANDOFF_CLAIM =
  /\b(?:i(?:['’]ll| will) take|i(?:['’]ve| have) got|je m(?:['’]en|en) occupe|c(?:['’]est|est) moi)\b/i;

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

export interface WhoTakesAsk {
  startIso: string;
  titleNorm: string;
  kid: string;
  event: string;
  day: string;
  time: string;
}

export interface HouseholdNotice {
  kind: 'kid_event' | 'conflict' | 'clash' | 'handoff' | 'followup' | 'who_takes';
  dedupeKey: string;
  /**
   * `activity_followup` has no frequency counter. Quiet hours and consent
   * still apply. There is no daily or weekly count on this path.
   */
  gateKind: 'activity_followup';
  category: 'calendar_alert' | 'followup';
  text: string;
  recipientUserId: string;
  /** Rows to stamp after the send lands. */
  mark: Array<{ integrationId: string; eventId: string; field: 'announced' | 'followup' }>;
  /** Set when this bubble may be followed by a who-takes poll. */
  whoTakes?: WhoTakesAsk;
  /** A clash alert's own who-takes poll, sent after it lands. */
  clashPoll?: { ask: WhoTakesPollSubject; options: readonly PollOptionWrite[] };
}

/** The plan a who-takes poll asks about, as its open ask is stored. */
interface WhoTakesPollSubject {
  startIso: string;
  titleNorm: string;
  kid: string | null;
  event: string | null;
}

/** Who-takes-it lines are pickup duty; a kid event or how-it-went is that event's logistics. */
const NOTICE_CLASS: Record<HouseholdNotice['kind'], ContentClass> = {
  kid_event: 'event_logistics',
  followup: 'event_logistics',
  conflict: 'pickup_duty',
  clash: 'pickup_duty',
  handoff: 'pickup_duty',
  who_takes: 'pickup_duty',
};

export interface HandoffStatement {
  userId: string;
  text: string;
  /** When the parent said it. Absent means the plan's own `now`. */
  at?: Date;
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
  /** A poll vote or a clear text reply already stored. Not a guess. */
  remembered?: readonly RememberedLogistics[];
  /** VIL-444: the clash alert owns overlaps, so no conflict line is planned here. */
  clashAlerts?: boolean;
}

/**
 * At most one bubble. Conflict, then an evening-before handoff, then up to
 * three new kid-event lines, then one how-it-went. Anything else is omitted.
 */
export async function planHouseholdNotices(input: NoticePlanInput): Promise<HouseholdNotice[]> {
  // A named handoff the evening before beats "who's taking it?": someone
  // already said, or the event is on exactly one calendar.
  const handoff = await soonestHandoff(input);
  if (handoff) return [handoff];
  const conflict = input.clashAlerts ? null : await soonestConflict(input);
  if (conflict) return [conflict];
  const kids = await batchedKidEvents(input);
  if (kids) return [kids];
  const followup = await soonestFollowup(input);
  return followup ? [followup] : [];
}

/**
 * Evening before, a tomorrow kid event, and nobody has said who takes it.
 * A conflict still owns that turn — this is only the case with no overlap.
 * Flag off does not call this. The bubble is the locked who-takes prompt.
 */
export async function planAmbiguousWhoTakes(
  input: NoticePlanInput,
): Promise<HouseholdNotice | null> {
  if (passedFigureItOutToday(input)) return null;
  const hour = zonedClock(input.now, input.timeZone).hour;
  if (hour < HANDOFF_HOUR_START || hour >= HANDOFF_HOUR_END) return null;
  const [first, second] = input.parentUserIds;
  const tomorrow = addDays(zonedParts(input.now, input.timeZone), 1);
  let best: BusyBlock | null = null;
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
    const memory = rememberedWhoTakes(
      input.remembered ?? [],
      block.start.toISOString(),
      normalizeTitle(block.title),
    );
    if (memory) continue;
    if (statedOwner(block, input.statements ?? [], input.blocks)) continue;
    if (soleCalendarOwner(block, input.blocks)) continue;
    const busy = input.blocks.some(
      (other) =>
        other.userId !== block.userId && other.status !== 'cancelled' && overlaps(block, other),
    );
    if (busy) continue;
    if (!best || block.start.getTime() < (best.start?.getTime() ?? 0)) best = block;
  }
  if (!best?.title || !best.start) return null;
  const parts = splitKidEvent(best.title, input.childNames);
  const recipient = otherParent(best.userId, first, second) ?? best.userId;
  if (!parts || !best.start) return null;
  const startIso = best.start.toISOString();
  const ask = whoTakesAsk(best, parts, input);
  const text = await whoTakesPrompt(input.language, ask);
  if (!text) return null;
  return {
    kind: 'who_takes',
    dedupeKey: `linq-group:who-takes:${best.eventId}:${startIso}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    text,
    recipientUserId: recipient,
    mark: [{ integrationId: best.integrationId, eventId: best.eventId, field: 'announced' }],
    whoTakes: ask,
  };
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

async function soonestConflict(input: NoticePlanInput): Promise<HouseholdNotice | null> {
  if (passedFigureItOutToday(input)) return null;
  const [first, second] = input.parentUserIds;
  let best: { block: BusyBlock; at: number } | null = null;
  for (const block of input.blocks) {
    if (!upcomingKid(block, input.now) || !block.start || !block.end) continue;
    if (block.start.getTime() < input.now.getTime()) continue;
    if (!block.title) continue;
    if (
      rememberedWhoTakes(
        input.remembered ?? [],
        block.start.toISOString(),
        normalizeTitle(block.title),
      )
    ) {
      continue;
    }
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
  const startIso = best.block.start.toISOString();
  const ask = whoTakesAsk(best.block, parts, input);
  const text = await groupConflictText(input.language, {
    kid: parts.kid,
    event: parts.event,
    day: ask.day,
    time: ask.time,
  });
  if (!text) return null;
  return {
    kind: 'conflict',
    dedupeKey: `linq-group:conflict:${best.block.eventId}:${startIso}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    text,
    recipientUserId: recipient,
    mark: [
      {
        integrationId: best.block.integrationId,
        eventId: best.block.eventId,
        field: 'announced',
      },
    ],
    whoTakes: ask,
  };
}

/** The locked who-takes prompt fields. Parent names are never filled in here. */
function whoTakesAsk(
  block: BusyBlock,
  parts: { kid: string; event: string },
  input: NoticePlanInput,
): WhoTakesAsk {
  const start = block.start ?? input.now;
  return {
    startIso: start.toISOString(),
    titleNorm: normalizeTitle(block.title ?? ''),
    kid: parts.kid,
    event: parts.event,
    day: formatDay(start, input.timeZone, input.language),
    time: formatTime(start, input.timeZone, input.language),
  };
}

/**
 * They already passed for today. No taker is stored. Do not ask again until
 * the next local day. A statement with no timestamp is this plan's own now.
 */
function passedFigureItOutToday(input: NoticePlanInput): boolean {
  const today = bothFreeDay(input.now, input.timeZone);
  return (input.statements ?? []).some((statement) => {
    if (!isFigureItOutLine(statement.text)) return false;
    const at = statement.at ?? input.now;
    return bothFreeDay(at, input.timeZone) === today;
  });
}

async function soonestHandoff(input: NoticePlanInput): Promise<HouseholdNotice | null> {
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
    const memory = block.title
      ? rememberedWhoTakes(
          input.remembered ?? [],
          block.start.toISOString(),
          normalizeTitle(block.title),
        )
      : null;
    // An open ask or a stored pass is not a taker. "We'll figure it out" stores none.
    // A stored vote names one. Otherwise the event on exactly one calendar does.
    if (memory?.status === 'declined' || memory?.status === 'open') continue;
    const sole = soleCalendarOwner(block, input.blocks);
    const owner = stated ?? (memory?.status === 'decided' ? memory.takerUserId : null) ?? sole;
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
  const text = await groupHandoffText(input.language, {
    name,
    kid: parts.kid,
    event: parts.event,
    time: formatTime(best.start, input.timeZone, input.language),
  });
  if (!text) return null;
  return {
    kind: 'handoff',
    dedupeKey: `linq-group:handoff:${best.eventId}:${best.start.toISOString()}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    text,
    recipientUserId: recipient,
    mark: [{ integrationId: best.integrationId, eventId: best.eventId, field: 'announced' }],
  };
}

async function batchedKidEvents(input: NoticePlanInput): Promise<HouseholdNotice | null> {
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
    const line = await groupKidEventText(input.language, {
      name,
      kid: parts.kid,
      event: parts.event,
      day: formatDay(block.start, input.timeZone, input.language),
      time: formatTime(block.start, input.timeZone, input.language),
    });
    if (!line) continue;
    lines.push(line);
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

async function soonestFollowup(input: NoticePlanInput): Promise<HouseholdNotice | null> {
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
  const text = await groupPostEventText(input.language, name, parts.event);
  if (!text) return null;
  return {
    kind: 'followup',
    dedupeKey: `linq-group:followup:${best.block.eventId}`,
    gateKind: 'activity_followup',
    category: 'followup',
    text,
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
export async function proposeSharedFree(input: {
  requested: boolean;
  blocks: readonly BusyBlock[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): Promise<string | null> {
  return (await sharedFreeOffer(input))?.text ?? null;
}

/** The locked both-free sentence plus the two slot phrases a poll can reuse. */
export async function sharedFreeOffer(input: {
  requested: boolean;
  blocks: readonly BusyBlock[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): Promise<{ text: string; slot1: string; slot2: string } | null> {
  if (!input.requested) return null;
  const slots = sharedFreeSlots(input.blocks, input.now, input.timeZone, 2);
  const first = slots[0];
  const second = slots[1];
  if (!first || !second) return null;
  const phrase = (slot: Date) =>
    `${formatDay(slot, input.timeZone, input.language)} ${formatTime(slot, input.timeZone, input.language)}`;
  const slot1 = phrase(first);
  const slot2 = phrase(second);
  const text = await groupBothFreeText(input.language, slot1, slot2);
  if (!text) return null;
  return { text, slot1, slot2 };
}

export function formatDay(date: Date, timeZone: string, language: ReplyLanguage | null): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatTime(date: Date, timeZone: string, language: ReplyLanguage | null): string {
  return new Intl.DateTimeFormat(localeFor(language), {
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

/**
 * Mailbox text is not group copy. A subject, sender, or body never comes
 * back from here. A kid date reaches the group only as the locked kid-event
 * notice, built from a calendar block, not from a message.
 */
export function kidMailboxSubject(_input: {
  subject: string;
  from?: string;
  body?: string;
  childNames: readonly string[];
}): null {
  return null;
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
  /** Users whose Google Calendar syncs now. One in error may be stale, so it is not here. */
  calendarUserIds: string[];
  bothMailboxes: boolean;
  timeZone: string;
  language: ReplyLanguage;
  chatId: string | null;
  childNames: string[];
  children: Array<{ id: string; name: string; dateOfBirth: string }>;
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
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const ids = parents.map((row) => row.userId).filter((id): id is string => Boolean(id));
  const parentUserIds =
    ids.length >= 2 && ids[0] && ids[1]
      ? ([ids[0], ids[1]] as const)
      : ids.length === 1 && ids[0]
        ? ([ids[0], ids[0]] as const)
        : null;
  return {
    parentUserIds,
    bothCalendars: gcal.size >= 2,
    calendarUserIds: connections
      .filter((row) => row.provider === 'gcal' && row.status === 'active')
      .map((row) => row.userId)
      .filter((id): id is string => typeof id === 'string'),
    bothMailboxes: gmail.size >= 2,
    timeZone: zone?.timezone ?? 'America/Toronto',
    language: family?.primaryLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    chatId: family?.linqGroupChatId ?? null,
    childNames: children.map((row) => row.name),
    children,
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
  if (!context.parentUserIds || !context.chatId) return;
  const { blocks, teens } = await loadSweepBlocks(database, input.familyId, context, input.now);
  const parentNames = await loadParentNames(database, context.parentUserIds);
  const statements = await loadHandoffStatements(
    database,
    input.familyId,
    context.chatId,
    input.now,
  );
  const remembered = await loadRememberedLogistics(database, input.familyId);
  const planInput: NoticePlanInput = {
    blocks,
    parentUserIds: context.parentUserIds,
    parentNames,
    childNames: context.childNames,
    now: input.now,
    timeZone: context.timeZone,
    language: context.language,
    statements,
    remembered,
  };
  const clashAlerts = linqGroupConflictAlertsEnabled();
  let notice: HouseholdNotice | null = null;
  if (clashAlerts) {
    const clash = await clashNotice(database, {
      familyId: input.familyId,
      chatId: context.chatId,
      now: input.now,
      timeZone: context.timeZone,
      language: context.language,
      parentUserIds: context.parentUserIds,
      parentNames,
      calendarUserIds: context.calendarUserIds,
      blocks,
      remembered,
      children: context.children,
      teens,
    });
    if (clash === 'unsent' || clash === 'held') return;
    notice = clash;
  }
  if (!notice) {
    const notices = await planHouseholdNotices({ ...planInput, clashAlerts });
    notice = notices[0] ?? null;
    if (linqPollsEnabled()) {
      const ambiguous = await planAmbiguousWhoTakes(planInput);
      if (ambiguous && (!notice || notice.kind === 'kid_event' || notice.kind === 'followup')) {
        notice = ambiguous;
      }
    }
  }
  if (!notice) return;
  if (linqPollsEnabled() && notice.kind === 'conflict' && notice.whoTakes) {
    const prompt = await whoTakesPrompt(context.language, notice.whoTakes);
    if (prompt) notice = { ...notice, text: prompt };
  }
  const audience = await groupAudienceAllows(database, context.chatId, NOTICE_CLASS[notice.kind]);
  if (!audience.allowed) {
    console.warn(
      { familyId: input.familyId, kind: notice.kind, reason: audience.reason },
      'household calendar: not for this group',
    );
    return;
  }
  const sent = await sendGroupNotice(database, {
    familyId: input.familyId,
    chatId: context.chatId,
    notice,
    now: input.now,
    fetch: input.fetch,
  });
  if (sent === 'sent' && notice.whoTakes && linqPollsEnabled()) {
    await attachWhoTakesPoll(database, {
      familyId: input.familyId,
      chatId: context.chatId,
      parentUserId: notice.recipientUserId,
      parents: context.parentUserIds.map((userId) => ({
        userId,
        name: parentNames[userId] ?? '',
      })),
      ask: notice.whoTakes,
      language: context.language,
      now: input.now,
      fetch: input.fetch,
    });
  }
  if (sent === 'sent' && notice.clashPoll) {
    await sendWhoTakesPoll(database, {
      familyId: input.familyId,
      chatId: context.chatId,
      parentUserId: notice.recipientUserId,
      ask: notice.clashPoll.ask,
      options: notice.clashPoll.options,
      idempotencyKey: `poll:${notice.dedupeKey}`,
      now: input.now,
      fetch: input.fetch,
    });
  }
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

/**
 * VIL-444 (T24) — the soonest clash this group has not been sent, written by the model.
 *
 * Null: no clash, every clash was already sent, or this group may not hear pickup duty.
 * `held`: the gate holds it now (quiet hours, consent), checked before the model is paid
 * to write. `unsent`: the model could not write it, so nothing goes out on this pass and
 * the next one asks again. People in the chat with no calendar Hale can read (a
 * caregiver, a parent who has not connected one) may be asked; the alert never calls
 * them free. With LINQ_POLLS on, the writer is offered the who-takes poll, and the
 * alert carries it only when the model wrote its last option.
 */
async function clashNotice(
  database: Database,
  input: ClashPlanningInput,
): Promise<HouseholdNotice | 'held' | 'unsent' | null> {
  const audience = await groupAudienceAllows(database, input.chatId, NOTICE_CLASS.clash);
  if (!audience.allowed) {
    console.warn(
      { familyId: input.familyId, kind: 'clash', reason: audience.reason },
      'household calendar: not for this group',
    );
    return null;
  }
  const { parents, people, plans, busy, kids } = await planClashes(database, input);
  const clashes = findGroupClashes({ plans, busy, people, now: input.now });
  for (const clash of clashes) {
    if (await dedupeActive(clash.dedupeKey, database)) continue;
    const pair = 'plan' in clash.second ? [clash.first, clash.second.plan] : [clash.first];
    const recipient =
      [clash.suggested?.personId, ...pair.map((plan) => clash.restsOn[plan.key])].find(
        (id): id is string => typeof id === 'string' && parents.includes(id),
      ) ?? parents[0];
    if (!recipient) return null;
    const verdict = await assertProactiveSendAllowed(
      {
        familyId: input.familyId,
        parentUserId: recipient,
        kind: 'activity_followup',
        now: input.now,
      },
      buildOutboundGatePorts(database),
    );
    if (!verdict.allowed) {
      console.warn(
        { familyId: input.familyId, kind: 'clash', reason: verdict.reason },
        'household calendar: group notice held',
      );
      return 'held';
    }
    const poll = linqPollsEnabled() ? clashPollOffer(clash, people) : null;
    const alert = await sharedGroupConflictWriter().write(
      groupConflictLineInput(clash, {
        people,
        kids,
        timeZone: input.timeZone,
        language: input.language,
        poll,
      }),
    );
    const key = poll ? pickupDecisionKey(poll.plan) : null;
    const options =
      poll && key && alert?.figureItOut
        ? clashPollOptions(poll, alert.figureItOut, whoTakesFactKey(key.startIso, key.titleNorm))
        : null;
    // A message written for a poll that cannot go would ask about a poll that is not there.
    if (!alert || (alert.figureItOut && !options)) {
      console.warn(
        { familyId: input.familyId, outcome: 'group_clash_unsent' },
        'household calendar: clash alert not written, nothing sent',
      );
      return 'unsent';
    }
    const parts = poll
      ? splitKidEvent(
          poll.plan.title,
          input.children.map((child) => child.name),
        )
      : null;
    return {
      kind: 'clash',
      dedupeKey: clash.dedupeKey,
      gateKind: 'activity_followup',
      category: 'calendar_alert',
      text: alert.text,
      recipientUserId: recipient,
      mark: pair.flatMap((plan) =>
        plan.rows.map((row) => ({ ...row, field: 'announced' as const })),
      ),
      ...(key && options
        ? {
            clashPoll: {
              ask: { ...key, kid: parts?.kid ?? null, event: parts?.event ?? null },
              options,
            },
          }
        : {}),
    };
  }
  return null;
}

interface ClashPlanningInput {
  familyId: string;
  chatId: string;
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
  parentUserIds: readonly string[];
  parentNames: Readonly<Record<string, string>>;
  calendarUserIds: readonly string[];
  blocks: readonly BusyBlock[];
  remembered: readonly RememberedLogistics[];
  children: readonly { id: string; name: string }[];
  teens: ReadonlySet<string>;
}

/**
 * What the clash planner reads for one household group: the parents and the caregivers
 * seated in this chat, every calendar row, the plans Hale holds (a private one only as its
 * taker's busy time), and the stored who-takes decisions. A claim and a vote on a
 * who-takes poll both settle a plan in the group.
 */
async function planClashes(
  database: Database,
  input: ClashPlanningInput,
): Promise<{
  parents: string[];
  people: ClashPerson[];
  plans: ClashPlan[];
  busy: ClashBusy[];
  kids: string[];
}> {
  const parents = [...new Set(input.parentUserIds)];
  const firstName = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] ?? '';
  const people: ClashPerson[] = parents.map((id) => ({
    id,
    name: firstName(input.parentNames[id]),
    calendar: input.calendarUserIds.includes(id),
  }));
  const seats = await database
    .select({
      userId: schema.linqGroupMembers.userId,
      role: schema.linqGroupMembers.role,
      name: schema.users.name,
    })
    .from(schema.linqGroupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.linqGroupMembers.userId))
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, input.chatId),
        eq(schema.linqGroupMembers.familyId, input.familyId),
        isNull(schema.linqGroupMembers.removedAt),
      ),
    );
  for (const seat of seats) {
    if (seat.role !== 'caregiver' || parents.includes(seat.userId)) continue;
    people.push({ id: seat.userId, name: firstName(seat.name), calendar: false });
  }
  const horizon = new Date(input.now.getTime() + LOOKAHEAD_MS);
  const ahead = and(
    gt(schema.familyEvents.endsAt, input.now),
    lte(schema.familyEvents.startsAt, horizon),
  );
  const copies = [...new Set(input.blocks.map((block) => block.eventId))];
  const rows = await database
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      childId: schema.familyEvents.childId,
      sensitive: schema.familyEvents.sensitive,
      dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId,
      dutyOwnerLabel: schema.familyEvents.dutyOwnerLabel,
      dutyOwnerKind: schema.familyEvents.dutyOwnerKind,
      dutySetAt: schema.familyEvents.dutySetAt,
      placedGoogleEventId: schema.familyEvents.placedGoogleEventId,
      placedGoogleIntegrationId: schema.familyEvents.placedGoogleIntegrationId,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, input.familyId),
        householdFamilyEvent(),
        copies.length > 0
          ? or(ahead, inArray(schema.familyEvents.placedGoogleEventId, copies))
          : ahead,
      ),
    );
  const childNames = input.children.map((child) => child.name);
  const teenNames = input.children
    .filter((child) => input.teens.has(child.id))
    .map((child) => child.name);
  const aboutTeen = (title: string) =>
    withoutTeenTitles([{ title, kidRelated: true }], childNames, teenNames)[0]?.title === null;
  // A private plan's calendar copy is busy time wherever either of them sits, so a copy
  // the parent dragged to another day still never carries the plan's title.
  const events = rows
    .map((row) => ({
      row,
      private:
        row.sensitive ||
        (row.childId !== null && input.teens.has(row.childId)) ||
        aboutTeen(row.title),
    }))
    .filter(
      ({ row, private: hidden }) =>
        hidden ||
        (row.endsAt !== null &&
          row.endsAt.getTime() > input.now.getTime() &&
          row.startsAt.getTime() <= horizon.getTime()),
    );
  const calendar = clashCalendar({
    blocks: input.blocks,
    events: events.map(({ row, private: hidden }) => ({
      id: row.id,
      title: row.title,
      start: row.startsAt,
      end: row.endsAt,
      private: hidden,
      owner:
        row.dutyOwnerKind === 'parent' && row.dutyOwnerUserId
          ? { kind: 'parent' as const, userId: row.dutyOwnerUserId }
          : row.dutyOwnerKind === 'named' && row.dutyOwnerLabel
            ? { kind: 'named' as const, label: row.dutyOwnerLabel }
            : null,
      ownerSince: row.dutySetAt,
      placedGoogleEventId: row.placedGoogleEventId,
      placedGoogleIntegrationId: row.placedGoogleIntegrationId,
    })),
    decided: (startIso, titleNorm) => {
      const memory = rememberedWhoTakes(input.remembered, startIso, titleNorm);
      return memory?.status === 'decided' && memory.takerUserId
        ? {
            takerId: memory.takerUserId,
            at: memory.since,
            claim: memory.source === 'claim' || memory.source === 'poll',
          }
        : null;
    },
  });
  for (const person of calendar.named) {
    if (!people.some((known) => known.id === person.id)) people.push(person);
  }
  const kids = childNames.filter((name) => !teenNames.includes(name));
  return { parents, people, plans: calendar.plans, busy: calendar.busy, kids };
}

async function loadSweepBlocks(
  database: Database,
  familyId: string,
  context: {
    childNames: readonly string[];
    children: ReadonlyArray<{ id: string; name: string; dateOfBirth: string }>;
  },
  now: Date,
): Promise<{ blocks: BusyBlock[]; teens: Set<string> }> {
  const rows = await database
    .select()
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, familyId));
  const teens = teenChildIds(context.children, now);
  const blocks: BusyBlock[] = withoutTeenTitles(
    rows.map((row) => ({
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
    })),
    context.childNames,
    context.children.filter((child) => teens.has(child.id)).map((child) => child.name),
  );
  return { blocks, teens };
}

async function loadParentNames(
  database: Database,
  parentUserIds: readonly string[],
): Promise<Record<string, string>> {
  const names = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, [...parentUserIds]));
  const parentNames: Record<string, string> = {};
  for (const row of names) {
    if (row.name) parentNames[row.id] = row.name;
  }
  return parentNames;
}

export type GroupPickupClaimOutcome =
  | 'flag_off'
  | 'no_text'
  | 'not_household_group'
  | 'not_for_this_group'
  | 'not_a_member'
  | 'no_pickups'
  | 'unread'
  | 'not_a_claim'
  | 'claimed'
  | 'already_claimed'
  | 'dropped'
  | 'nothing_to_drop'
  | 'superseded';

/**
 * VIL-444 (T24) — a pickup a group member took, or gave back, read by the model by meaning.
 *
 * A claim stores the sender as that plan's taker (source `claim`): the clash planner never
 * alerts about it and holds the sender busy then, and the evening poll does not ask who
 * takes it. A drop closes the sender's own stored decision. Only a parent, or a caregiver
 * seated in this chat, can do either, and only on plans the planner watches, so a private
 * plan never reaches the model. Either is stored as of when it was said, and never over
 * anything stored about that plan after it: Linq can retry a message, or deliver it late,
 * after someone else took or gave back the pickup (`superseded`). Nothing is sent from here.
 */
export async function takeGroupPickupClaim(
  database: Database,
  input: {
    familyId: string;
    chatId: string;
    senderUserId: string;
    text: string;
    /** When the sender sent it: the payload's own time, the same on every retry. */
    sentAt: Date;
    now: Date;
  },
  ports: { reader?: GroupPickupClaimReader } = {},
): Promise<GroupPickupClaimOutcome> {
  if (!linqGroupCoparentEnabled() || !linqGroupConflictAlertsEnabled()) return 'flag_off';
  const text = input.text.trim();
  if (!text) return 'no_text';
  const context = await loadFamilyCalendarContext(database, input.familyId);
  if (!context.parentUserIds || context.chatId !== input.chatId) return 'not_household_group';
  const audience = await groupAudienceAllows(database, input.chatId, NOTICE_CLASS.clash);
  if (!audience.allowed) return 'not_for_this_group';
  const { blocks, teens } = await loadSweepBlocks(database, input.familyId, context, input.now);
  const remembered = await loadRememberedLogistics(database, input.familyId);
  const { people, plans, busy } = await planClashes(database, {
    familyId: input.familyId,
    chatId: input.chatId,
    now: input.now,
    timeZone: context.timeZone,
    language: context.language,
    parentUserIds: context.parentUserIds,
    parentNames: await loadParentNames(database, context.parentUserIds),
    calendarUserIds: context.calendarUserIds,
    blocks,
    remembered,
    children: context.children,
    teens,
  });
  if (!people.some((person) => person.id === input.senderUserId)) return 'not_a_member';
  const sent: GroupClash[] = [];
  for (const clash of findGroupClashes({ plans, busy, people, now: input.now })) {
    if (await dedupeActive(clash.dedupeKey, database)) sent.push(clash);
  }
  const candidates = pickupCandidates({
    plans,
    sent,
    people,
    now: input.now,
    timeZone: context.timeZone,
    language: context.language,
  });
  if (candidates.length === 0) return 'no_pickups';
  const reading = await (ports.reader ?? sharedGroupPickupClaimReader()).read({
    text,
    pickups: candidates.map((candidate) => candidate.offer),
    ...(await groupTurnReadContext(database, {
      familyId: input.familyId,
      chatId: input.chatId,
      senderUserId: input.senderUserId,
    })),
  });
  if (!reading) return 'unread';
  const action = pickupClaimAction(
    reading,
    candidates,
    plans.filter((plan) => watchedPlan(plan, input.now)),
  );
  if (!action) return 'not_a_claim';
  const saidAt = input.sentAt.getTime() < input.now.getTime() ? input.sentAt : input.now;
  const changedSince = (factKey: string) =>
    whoTakesChangedSince(database, {
      familyId: input.familyId,
      factKey,
      sentAt: saidAt,
      remembered,
    });
  let superseded = false;
  if (action.kind === 'drop') {
    let dropped = false;
    for (const plan of action.plans) {
      const key = pickupDecisionKey(plan);
      const factKey = whoTakesFactKey(key.startIso, key.titleNorm);
      const memory = rememberedWhoTakes(remembered, key.startIso, key.titleNorm);
      if (memory?.status !== 'decided' || memory.takerUserId !== input.senderUserId) continue;
      if (await changedSince(factKey)) {
        superseded = true;
        continue;
      }
      await withholdWhoTakes(database, {
        familyId: input.familyId,
        parentUserId: input.senderUserId,
        factKey,
        now: saidAt,
        source: 'claim',
      });
      dropped = true;
    }
    return dropped ? 'dropped' : superseded ? 'superseded' : 'nothing_to_drop';
  }
  let claimed = false;
  for (const plan of action.plans) {
    if (plan.claimed && plan.takerId === input.senderUserId) continue;
    const key = pickupDecisionKey(plan);
    const factKey = whoTakesFactKey(key.startIso, key.titleNorm);
    if (await changedSince(factKey)) {
      superseded = true;
      continue;
    }
    const parts = splitKidEvent(plan.title, context.childNames);
    await writeLogisticsDecision(database, {
      familyId: input.familyId,
      parentUserId: input.senderUserId,
      factKey,
      childId: null,
      now: saidAt,
      value: {
        kind: 'who_takes',
        status: 'decided',
        startIso: key.startIso,
        titleNorm: key.titleNorm,
        takerUserId: input.senderUserId,
        slotLabel: null,
        slotStart: null,
        kid: parts?.kid ?? null,
        event: parts?.event ?? null,
        day: null,
        slots: [],
        source: 'claim',
      },
    });
    claimed = true;
  }
  return claimed ? 'claimed' : superseded ? 'superseded' : 'already_claimed';
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
    .map((row) => ({
      userId: row.parentUserId as string,
      text: row.body as string,
      at: row.createdAt,
    }));
}

/**
 * Mail stays out of the group. Subjects, senders, and bodies are not spoken
 * here, and this function does not render them. A kid date is a calendar
 * notice ({@link groupKidEventText}), never a line built from an envelope.
 * The owner's existing SMS email alert is a different path. The return is
 * named so a caller can see the suppression.
 */
export async function narrateHouseholdMailbox(
  _database: Database,
  input: {
    familyId: string;
    userId: string;
    envelopes: readonly { messageId: string; subject: string; from?: string; body?: string }[];
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

/**
 * The who-takes prompt already went out as the one bubble. The poll is the
 * choices, not a second question, and not the locked conflict sentence.
 * A missing or duplicated name is no poll — the text stands.
 */
async function attachWhoTakesPoll(
  database: Database,
  input: {
    familyId: string;
    chatId: string;
    parentUserId: string;
    parents: readonly { userId: string; name: string }[];
    ask: WhoTakesAsk;
    language: ReplyLanguage;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<void> {
  const factKey = whoTakesFactKey(input.ask.startIso, input.ask.titleNorm);
  const options = await whoTakesPollOptions(input.language, input.parents, factKey);
  if (!options) return;
  await sendWhoTakesPoll(database, {
    familyId: input.familyId,
    chatId: input.chatId,
    parentUserId: input.parentUserId,
    ask: input.ask,
    options,
    idempotencyKey: `poll:${factKey}:${input.familyId}`.slice(0, 180),
    now: input.now,
    fetch: input.fetch,
  });
}

/**
 * The poll alone, its bubble already landed, then the plan held open until someone
 * answers: no evening ask or handoff names a taker meanwhile. A decision stored by the
 * time the poll lands (a claim read while the alert was written, a reply by text) stays;
 * the open ask never writes over it.
 */
async function sendWhoTakesPoll(
  database: Database,
  input: {
    familyId: string;
    chatId: string;
    parentUserId: string;
    ask: WhoTakesPollSubject;
    options: readonly PollOptionWrite[];
    idempotencyKey: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<void> {
  const factKey = whoTakesFactKey(input.ask.startIso, input.ask.titleNorm);
  const poll = await sendChoicePoll(database, {
    chatId: input.chatId,
    prompt: null,
    options: input.options,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    fetch: input.fetch,
    idempotencyKey: input.idempotencyKey,
  });
  if (poll.status !== 'sent' && poll.status !== 'prompted') return;
  const live = rememberedWhoTakes(
    await loadRememberedLogistics(database, input.familyId),
    input.ask.startIso,
    input.ask.titleNorm,
  );
  if (live && live.status !== 'open') return;
  await writeLogisticsDecision(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    factKey,
    childId: null,
    now: input.now,
    value: {
      kind: 'who_takes',
      status: 'open',
      startIso: input.ask.startIso,
      titleNorm: input.ask.titleNorm,
      takerUserId: null,
      slotLabel: null,
      slotStart: null,
      kid: input.ask.kid,
      event: input.ask.event,
      day: null,
      slots: [],
      source: 'poll',
    },
  });
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
    // The claimed group chat is the only door. `chatId` is `families.linq_group_chat_id`.
    // A refusal stays `not_sent` — this does not call Twilio.
    const sent = await sendLinqChatMessage({
      chatId: input.chatId,
      text: body,
      fetch: input.fetch,
    });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    const audit = {
      familyId: input.familyId,
      actor: 'system' as const,
      targetTable: 'channel_messages' as const,
      targetId: claimed.id,
      after: { kind: input.notice.kind },
    };
    if (input.notice.category === 'followup') {
      await database.insert(schema.auditLog).values({ ...audit, actionTaken: 'sms_reply_sent' });
    } else {
      await database
        .insert(schema.auditLog)
        .values({ ...audit, actionTaken: 'calendar_alert_sent' });
    }
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
  return (await answerBothFreeOffer(database, input))?.text ?? null;
}

/**
 * The locked both-free sentence when the flag is off. Two slots only.
 * A poll, when LINQ_POLLS is on and there are two or more slots, is
 * {@link deliverBothFreeAsk}. One slot stays quiet: there is no locked
 * one-slot sentence, and this ticket does not invent one.
 */
export async function answerBothFreeOffer(
  database: Database,
  input: { familyId: string; now: Date; language: ReplyLanguage },
): Promise<{ text: string; slot1: string; slot2: string } | null> {
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
  return await sharedFreeOffer({
    requested: true,
    blocks,
    now: input.now,
    timeZone: context.timeZone,
    language: input.language,
  });
}

/** Up to three shared hours, labeled the same way the locked sentence labels two. */
export function listSharedFreeSlots(input: {
  requested: boolean;
  blocks: readonly BusyBlock[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage | null;
}): LogisticsSlot[] {
  if (!input.requested) return [];
  return sharedFreeSlots(input.blocks, input.now, input.timeZone, 3).map((slot) => ({
    label: `${formatDay(slot, input.timeZone, input.language)} ${formatTime(slot, input.timeZone, input.language)}`,
    startIso: slot.toISOString(),
  }));
}

export type BothFreeDelivery =
  | { mode: 'none' }
  | { mode: 'text'; text: string }
  | {
      mode: 'poll';
      prompt: string;
      options: readonly {
        text: string;
        pollKind?: string | null;
        subjectKey?: string | null;
        choiceKind?: string | null;
        choiceValue?: string | null;
      }[];
      factKey: string;
      day: string;
      slots: readonly LogisticsSlot[];
    };

/**
 * Parent asked. Flag off and two or more slots: the locked sentence.
 * Flag on and two or more slots: the locked prompt plus a slot poll.
 * The locked both-free sentence is not sent on that turn.
 * One slot: nothing. A fresh decision for today: nothing.
 * A slot pick is stored for the existing find page handoff. This does not
 * send a second sentence. "None of these" ends the ask.
 */
export async function planBothFreeAsk(
  database: Database,
  input: { familyId: string; now: Date; language: ReplyLanguage | null },
): Promise<BothFreeDelivery> {
  const context = await loadFamilyCalendarContext(database, input.familyId);
  const blocks = await loadFamilyBlocks(database, input.familyId);
  const day = bothFreeDay(input.now, context.timeZone);
  const remembered = await loadRememberedLogistics(database, input.familyId);
  if (remembered.some((row) => row.factKey === bothFreeFactKey(day))) return { mode: 'none' };
  const slots = listSharedFreeSlots({
    requested: true,
    blocks,
    now: input.now,
    timeZone: context.timeZone,
    language: input.language,
  });
  if (slots.length < 2) return { mode: 'none' };
  if (!linqPollsEnabled()) {
    const text = await groupBothFreeText(
      input.language,
      slots[0]?.label ?? '',
      slots[1]?.label ?? '',
    );
    if (!text) return { mode: 'none' };
    return { mode: 'text', text };
  }
  const factKey = bothFreeFactKey(day);
  const options = await bothFreePollOptions(input.language, slots, factKey);
  const prompt = await bothFreePrompt(input.language);
  if (!options || !prompt) return { mode: 'none' };
  return { mode: 'poll', prompt, options, factKey, day, slots };
}

export async function rememberBothFreeAsked(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    factKey: string;
    day: string;
    slots: readonly LogisticsSlot[];
    now: Date;
  },
): Promise<void> {
  await writeLogisticsDecision(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    factKey: input.factKey,
    childId: null,
    now: input.now,
    value: {
      kind: 'both_free',
      status: 'open',
      startIso: null,
      titleNorm: null,
      takerUserId: null,
      slotLabel: null,
      slotStart: null,
      kid: null,
      event: null,
      day: input.day,
      slots: [...input.slots],
      source: 'poll',
    },
  });
}

/**
 * A clear who-takes or slot reply, in the group or in a 1:1 the parent
 * started. Stored on the family so the evening handoff can read it. Does not
 * send. An unclear sentence is left alone. With `sentAt`, a who-takes reply is
 * stored as of when it was sent, and never over a decision stored after that.
 */
export async function captureLogisticsText(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
    /** A group message: Linq can retry it, or deliver it late, before anything dedupes it. */
    sentAt?: Date;
    now: Date;
  },
): Promise<'stored' | 'skipped' | 'withheld'> {
  if (typeof database.select !== 'function') return 'skipped';
  const context = await loadFamilyCalendarContext(database, input.familyId);
  if (!context.parentUserIds) return 'skipped';
  const names = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, [...context.parentUserIds]));
  const parents = context.parentUserIds.map((userId) => ({
    userId,
    name: names.find((row) => row.id === userId)?.name ?? '',
  }));
  const remembered = await loadRememberedLogistics(database, input.familyId);
  const blocks = await loadFamilyBlocks(database, input.familyId);
  const who = readWhoTakesReply(input.body, parents, input.parentUserId);
  const saidAt =
    input.sentAt && input.sentAt.getTime() < input.now.getTime() ? input.sentAt : input.now;
  const changedSince = async (factKey: string): Promise<boolean> =>
    input.sentAt
      ? whoTakesChangedSince(database, {
          familyId: input.familyId,
          factKey,
          sentAt: saidAt,
          remembered,
        })
      : false;
  if (who && 'declined' in who) {
    const target = matchWhoTakesTarget(input.body, blocks, input.now, context.childNames);
    if (target) {
      const factKey = whoTakesFactKey(target.startIso, target.titleNorm);
      if (await changedSince(factKey)) return 'skipped';
      await withholdWhoTakes(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        factKey,
        now: saidAt,
        source: 'text',
      });
    }
    return 'withheld';
  }
  if (who) {
    const target = matchWhoTakesTarget(input.body, blocks, input.now, context.childNames);
    if (!target) return 'skipped';
    const factKey = whoTakesFactKey(target.startIso, target.titleNorm);
    if (await changedSince(factKey)) return 'skipped';
    await writeLogisticsDecision(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      factKey,
      childId: null,
      now: saidAt,
      value: {
        kind: 'who_takes',
        status: 'declined' in who ? 'declined' : 'decided',
        startIso: target.startIso,
        titleNorm: target.titleNorm,
        takerUserId: 'takerUserId' in who ? who.takerUserId : null,
        slotLabel: null,
        slotStart: null,
        kid: target.kid,
        event: target.event,
        day: null,
        slots: [],
        source: 'text',
      },
    });
    return 'stored';
  }
  const openSlot = remembered.find((row) => row.kind === 'both_free' && row.status === 'open');
  if (!openSlot) return 'skipped';
  const slot = readSlotReply(input.body, openSlot.slots);
  if (!slot) return 'skipped';
  await writeLogisticsDecision(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    factKey: openSlot.factKey,
    childId: null,
    now: input.now,
    value: {
      kind: 'both_free',
      status: 'declined' in slot ? 'declined' : 'decided',
      startIso: null,
      titleNorm: null,
      takerUserId: null,
      slotLabel: 'slot' in slot ? slot.slot.label : null,
      slotStart: 'slot' in slot ? slot.slot.startIso : null,
      kid: null,
      event: null,
      day: openSlot.day,
      slots: [...openSlot.slots],
      source: 'text',
    },
  });
  return 'stored';
}

function matchWhoTakesTarget(
  body: string,
  blocks: readonly BusyBlock[],
  now: Date,
  childNames: readonly string[],
): { startIso: string; titleNorm: string; kid: string; event: string } | null {
  const open = blocks.filter((block) => upcomingKid(block, now) && block.title && block.start);
  const normalized = body.trim().toLowerCase();
  const named = open.filter((block) => normalized.includes(normalizeTitle(block.title as string)));
  const pool = named.length > 0 ? named : open;
  const unique = new Map<string, BusyBlock>();
  for (const block of pool) {
    const key = `${(block.start as Date).toISOString()}/${normalizeTitle(block.title as string)}`;
    unique.set(key, block);
  }
  if (unique.size !== 1) return null;
  const block = [...unique.values()][0];
  if (!block?.title || !block.start) return null;
  const parts = splitKidEvent(block.title, childNames);
  if (!parts) return null;
  return {
    startIso: block.start.toISOString(),
    titleNorm: normalizeTitle(block.title),
    kid: parts.kid,
    event: parts.event,
  };
}

async function loadFamilyBlocks(database: Database, familyId: string): Promise<BusyBlock[]> {
  const rows = await database
    .select()
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, familyId));
  return rows
    .filter((row) => row.familyId === familyId)
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
}

export async function familyHasTwoCalendars(
  database: Database,
  familyId: string,
): Promise<boolean> {
  const context = await loadFamilyCalendarContext(database, familyId);
  return context.bothCalendars;
}

interface HouseholdCalendarSweepInput {
  integrationId: string;
  familyId: string;
  userId: string | null;
  changes: readonly CalendarChange[];
  seeding: boolean;
  now: Date;
  fetch?: typeof fetch;
}

/** The remember half alone, for a sweep that may not speak. Blocks left unannounced
 * are picked up by the next narrate. */
export async function rememberHouseholdCalendar(
  database: Database,
  input: HouseholdCalendarSweepInput,
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
    bothCalendars: context.chatId !== null || context.bothCalendars,
    now: input.now,
  });
}

/** Used by the connector sweep. Failures stay inside the caller. */
export async function rememberAndNarrateCalendar(
  database: Database,
  input: HouseholdCalendarSweepInput,
): Promise<void> {
  if (!linqGroupCoparentEnabled() || !input.userId) return;
  await rememberHouseholdCalendar(database, input);
  await narrateHouseholdCalendar(database, {
    familyId: input.familyId,
    now: input.now,
    fetch: input.fetch,
  });
}
