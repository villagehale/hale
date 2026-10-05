import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { withOptOut } from '~/lib/channel/opt-out';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { CalendarChange } from '~/lib/integrations/calendar-alert';
import { linqGroupCoparentEnabled, linqPollsEnabled } from './config';
import { groupProactiveCapReached } from './family-outbound';
import { classifyKidCalendarItem, splitKidEvent, titleForStorage } from './kid-event';

export { classifyKidCalendarItem, splitKidEvent, titleForStorage };
import {
  type GroupKidEventFact,
  type GroupLineRequest,
  type GroupVoice,
  defaultGroupVoice,
  speakGroupLine,
} from './group-voice';
import {
  type LogisticsSlot,
  type RememberedLogistics,
  bothFreeDay,
  bothFreeFactKey,
  bothFreePollOptions,
  isFigureItOutLine,
  loadRememberedLogistics,
  readSlotReply,
  readWhoTakesReply,
  rememberedWhoTakes,
  whoTakesFactKey,
  whoTakesPollOptions,
  withholdWhoTakes,
  writeLogisticsDecision,
} from './logistics-poll';
import { sendChoicePoll } from './poll';
import { LinqSendError, sendLinqChatMessage } from './transport';

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
 * Proactive group speech is one bubble: at most one a day and three a week,
 * never during quiet hours. A cancellation, a weekly recap, and an unprompted
 * both-free suggestion are not bubbles.
 *
 * VIL-413 / VIL-417: every bubble here is written by the model from the real
 * facts the planner found (group-voice.ts). The planner stays pure and
 * decides WHAT is said; the send composes it. When LINQ_POLLS is on, the
 * conflict and who-takes questions are followed by the poll on the same
 * turn; the poll ledger row does not spend a second discretionary bubble.
 * Flag off asks the same question in words and does not poll. A line the
 * model cannot write is not sent and the event is not marked, so the next
 * sweep tries again. "We'll figure it out" stores no taker
 * and does not ask again that day.
 *
 * Kid-event, conflict, handoff, and post-event notices leave only through the
 * family's `linq_group_chat_id`. A Linq refusal is `not_sent`. Nothing on this
 * path sends SMS, and a failed group send is not retried on Twilio.
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
  kind: 'kid_event' | 'conflict' | 'handoff' | 'followup' | 'who_takes';
  dedupeKey: string;
  /**
   * `activity_followup` has no frequency counter, so an SMS calendar alert
   * cannot eat the group's own 1/day and 3/week cap. Quiet hours and consent
   * still apply. The group's cap is counted on the template keys below.
   */
  gateKind: 'activity_followup';
  category: 'calendar_alert' | 'followup';
  /** What the model is asked to say, with only the facts the planner found. */
  line: GroupLineRequest;
  recipientUserId: string;
  /** Rows to stamp after the send lands. */
  mark: Array<{ integrationId: string; eventId: string; field: 'announced' | 'followup' }>;
  /** Set when this bubble may be followed by a who-takes poll. */
  whoTakes?: WhoTakesAsk;
}

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

/**
 * Evening before, a tomorrow kid event, and nobody has said who takes it.
 * A conflict still owns that turn — this is only the case with no overlap.
 * Flag off does not call this. The bubble is the locked who-takes prompt.
 */
export function planAmbiguousWhoTakes(input: NoticePlanInput): HouseholdNotice | null {
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
  return {
    kind: 'who_takes',
    dedupeKey: `linq-group:who-takes:${best.eventId}:${startIso}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    line: { kind: 'who_takes', kid: ask.kid, event: ask.event, day: ask.day, time: ask.time },
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

function soonestConflict(input: NoticePlanInput): HouseholdNotice | null {
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
  return {
    kind: 'conflict',
    dedupeKey: `linq-group:conflict:${best.block.eventId}:${startIso}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    line: { kind: 'conflict', kid: parts.kid, event: parts.event, day: ask.day, time: ask.time },
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
  return {
    kind: 'handoff',
    dedupeKey: `linq-group:handoff:${best.eventId}:${best.start.toISOString()}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    line: {
      kind: 'handoff',
      name,
      kid: parts.kid,
      event: parts.event,
      time: formatTime(best.start, input.timeZone, input.language),
    },
    recipientUserId: recipient,
    mark: [{ integrationId: best.integrationId, eventId: best.eventId, field: 'announced' }],
  };
}

function batchedKidEvents(input: NoticePlanInput): HouseholdNotice | null {
  const [first, second] = input.parentUserIds;
  const fresh = input.blocks
    .filter((block) => upcomingKid(block, input.now) && !block.announced && block.start)
    .sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  const events: GroupKidEventFact[] = [];
  const mark: HouseholdNotice['mark'] = [];
  const ids: string[] = [];
  let recipient: string | null = null;
  for (const block of fresh) {
    if (events.length >= KID_LINES_MAX) break;
    if (!block.title || !block.start) continue;
    const parts = splitKidEvent(block.title, input.childNames);
    const name = input.parentNames[block.userId]?.trim();
    const other = otherParent(block.userId, first, second);
    if (!parts || !name || !other) continue;
    events.push({
      parent: name,
      kid: parts.kid,
      event: parts.event,
      day: formatDay(block.start, input.timeZone, input.language),
      time: formatTime(block.start, input.timeZone, input.language),
    });
    mark.push({ integrationId: block.integrationId, eventId: block.eventId, field: 'announced' });
    ids.push(block.eventId);
    recipient ??= other;
  }
  if (events.length === 0 || !recipient) return null;
  return {
    kind: 'kid_event',
    dedupeKey: `linq-group:kids:${ids.join(':')}`,
    gateKind: 'activity_followup',
    category: 'calendar_alert',
    line: { kind: 'kid_event', events },
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
    line: { kind: 'how_it_went', name, activity: parts.event },
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
 * The two shared-free slot phrases the model is handed. `requested` must be
 * true: a calendar sweep never sets it. Null when fewer than two shared hours
 * exist. Hale does not book.
 */
export function proposeSharedFree(input: {
  requested: boolean;
  blocks: readonly BusyBlock[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): readonly [string, string] | null {
  const offer = sharedFreeOffer(input);
  return offer ? [offer.slot1, offer.slot2] : null;
}

/** The two slot phrases, formatted once so the line and a poll name the same hours. */
export function sharedFreeOffer(input: {
  requested: boolean;
  blocks: readonly BusyBlock[];
  now: Date;
  timeZone: string;
  language: ReplyLanguage;
}): { slot1: string; slot2: string } | null {
  if (!input.requested) return null;
  const slots = sharedFreeSlots(input.blocks, input.now, input.timeZone, 2);
  const first = slots[0];
  const second = slots[1];
  if (!first || !second) return null;
  const phrase = (slot: Date) =>
    `${formatDay(slot, input.timeZone, input.language)} ${formatTime(slot, input.timeZone, input.language)}`;
  return { slot1: phrase(first), slot2: phrase(second) };
}

/**
 * A parent asking for a shared free window. Conservative: two-slot copy is
 * never attached to a nudge. (Intent routing; the answer itself is the model's.)
 */
const BOTH_FREE_ASK =
  /\b(?:both free|when (?:are|can) we both|free together|tous les deux libres|libres tous les deux|quand (?:est-ce qu'on|on) est libres)\b/i;

export function matchBothFreeAsk(body: string): boolean {
  return BOTH_FREE_ASK.test(body);
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
    /** The group's model voice. Absent falls back to the production composer. */
    voice?: GroupVoice;
  },
): Promise<void> {
  if (!linqGroupCoparentEnabled()) return;
  const context = await loadFamilyCalendarContext(database, input.familyId);
  if (!context.parentUserIds || !context.chatId) return;
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
  const notices = planHouseholdNotices(planInput);
  let notice = notices[0] ?? null;
  if (linqPollsEnabled()) {
    const ambiguous = planAmbiguousWhoTakes(planInput);
    if (ambiguous && (!notice || notice.kind === 'kid_event' || notice.kind === 'followup')) {
      notice = ambiguous;
    }
  }
  // With polls on, a conflict is asked as the who-takes question and the poll
  // carries the choices: one bubble, and nobody is said to be busy.
  if (linqPollsEnabled() && notice?.kind === 'conflict' && notice.whoTakes) {
    const ask = notice.whoTakes;
    notice = {
      ...notice,
      line: { kind: 'who_takes', kid: ask.kid, event: ask.event, day: ask.day, time: ask.time },
    };
  }
  if (!notice) return;
  if (
    await groupProactiveCapReached(database, {
      familyId: input.familyId,
      chatId: context.chatId,
      now: input.now,
    })
  ) {
    console.warn({ familyId: input.familyId }, 'household calendar: group cap reached');
    return;
  }
  const sent = await sendGroupNotice(database, {
    familyId: input.familyId,
    chatId: context.chatId,
    notice,
    language: context.language,
    now: input.now,
    fetch: input.fetch,
    voice: input.voice,
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
 * notice (the group-voice `kid_event` line), never a line built from an envelope.
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
  const options = whoTakesPollOptions(input.language, input.parents, factKey);
  if (!options) return;
  const poll = await sendChoicePoll(database, {
    chatId: input.chatId,
    prompt: null,
    options,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    fetch: input.fetch,
    idempotencyKey: `poll:${factKey}:${input.familyId}`.slice(0, 180),
  });
  if (poll.status !== 'sent' && poll.status !== 'prompted') return;
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
    language: ReplyLanguage;
    now: Date;
    fetch?: typeof fetch;
    voice?: GroupVoice;
  },
): Promise<'sent' | 'already_sent' | 'held' | 'not_sent' | 'voice_unsent'> {
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
  // Composed before the claim: a line the model cannot write leaves the key
  // unspent and the event unmarked, so the next sweep tries again.
  const spoken = await speakGroupLine(
    input.voice ?? defaultGroupVoice(),
    input.notice.line,
    input.language,
  );
  if (spoken.source === 'unsent') return 'voice_unsent';
  const body = withOptOut(spoken.body, verdict.optOut);
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

/**
 * The two shared slots a parent asked about. Two slots only; one slot stays
 * quiet. Never called from the sweep. The sentence is the model's
 * (group-voice `both_free`), from these two phrases.
 */
export async function answerBothFreeOffer(
  database: Database,
  input: { familyId: string; now: Date; language: ReplyLanguage },
): Promise<{ slot1: string; slot2: string } | null> {
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
  return sharedFreeOffer({
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
  language: ReplyLanguage;
}): LogisticsSlot[] {
  if (!input.requested) return [];
  return sharedFreeSlots(input.blocks, input.now, input.timeZone, 3).map((slot) => ({
    label: `${formatDay(slot, input.timeZone, input.language)} ${formatTime(slot, input.timeZone, input.language)}`,
    startIso: slot.toISOString(),
  }));
}

export type BothFreeDelivery =
  | { mode: 'none' }
  | { mode: 'text'; slotLabels: readonly [string, string] }
  | {
      mode: 'poll';
      slotLabels: readonly [string, string];
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
  input: { familyId: string; now: Date; language: ReplyLanguage },
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
  const [firstSlot, secondSlot] = slots;
  if (!firstSlot || !secondSlot) return { mode: 'none' };
  const slotLabels: readonly [string, string] = [firstSlot.label, secondSlot.label];
  if (!linqPollsEnabled()) return { mode: 'text', slotLabels };
  const factKey = bothFreeFactKey(day);
  const options = bothFreePollOptions(input.language, slots, factKey);
  if (!options) return { mode: 'none' };
  return { mode: 'poll', slotLabels, options, factKey, day, slots };
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
 * send. An unclear sentence is left alone.
 */
export async function captureLogisticsText(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    body: string;
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
  if (who && 'declined' in who) {
    const target = matchWhoTakesTarget(input.body, blocks, input.now, context.childNames);
    if (target) {
      await withholdWhoTakes(database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        factKey: whoTakesFactKey(target.startIso, target.titleNorm),
        now: input.now,
        source: 'text',
      });
    }
    return 'withheld';
  }
  if (who) {
    const target = matchWhoTakesTarget(input.body, blocks, input.now, context.childNames);
    if (!target) return 'skipped';
    await writeLogisticsDecision(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      factKey: whoTakesFactKey(target.startIso, target.titleNorm),
      childId: null,
      now: input.now,
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
    voice?: GroupVoice;
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
    bothCalendars: context.chatId !== null || context.bothCalendars,
    now: input.now,
  });
  await narrateHouseholdCalendar(database, {
    familyId: input.familyId,
    now: input.now,
    fetch: input.fetch,
    voice: input.voice,
  });
}
