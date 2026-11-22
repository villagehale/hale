import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
import {
  DUTY_SEND_IN_FLIGHT,
  dutyFailureCode,
  mayHaveLanded,
} from '~/lib/channel/coparent/duty/send-receipt';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { carpoolReminderFireAt } from '~/lib/channel/linq/carpool-cadence';
import { GARBLED_TEXT } from '~/lib/channel/linq/transport';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveHoldReason,
  type ProactiveSendVerdict,
  PROACTIVE_CATEGORY,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import {
  type ResolvedOutbound,
  failedSendPatch,
  readSendRefusal,
  sendLinqChatMessage,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import {
  COMPOSE_HOLD_MAX_ATTEMPTS,
  REMINDER_OFFSETS,
  nextComposeHold,
  reminderFireAt,
} from '~/lib/loop/reminders/schedule';
import type { OpsPager } from '~/lib/monitoring/failure-page';
import { dayKeyIn } from '~/lib/plan/spine';
import { teamScheduleChangesActive, teamScheduleSendReceiptEnabled } from './flag';
import type { SpokenChange } from './voice';

/**
 * VIL-662 · after a calendar_move / calendar_cancel executes: re-anchor the
 * kid-event reminders, move the carpool night-before reminder, and text the
 * duty or carpool driver. Linq only. The model writes the driver line; if it
 * cannot, nothing is sent to them.
 */

export const TEAM_SCHEDULE_DRIVER_TEMPLATE_KEY = 'team_schedule:driver';

export interface TeamScheduleDriver {
  userId: string;
}

export interface DriverNotifyPorts {
  composeDriver(input: {
    userId: string;
    change: SpokenChange;
    kid: string | null;
    team: string | null;
    wasAt: Date | null;
    whenAt: Date | null;
    place: string | null;
    /** Set on a retry: the drain's queues are waiting behind this compose. */
    signal?: AbortSignal;
  }): Promise<string | null>;
  gate(input: {
    familyId: string;
    parentUserId: string;
    now: Date;
  }): Promise<ProactiveSendVerdict>;
  resolvePhone(database: Database, parentUserId: string): Promise<string | null>;
  transport: ChannelTransport;
  /** The Linq 1:1 send, for a driver whose door is an iMessage chat. */
  sendChat: typeof sendLinqChatMessage;
  threadMessage: typeof threadProactiveMessage;
  /** The time now. A compose can outlast the run's own start time. */
  clock(): Date;
  /** #ops, when a driver's text reached them on no try. */
  pager: OpsPager;
}

export async function loadAffectedDrivers(
  database: Database,
  input: {
    familyId: string;
    familyEventId: string;
    originalStartsAt: Date;
    timeZone: string;
  },
): Promise<TeamScheduleDriver[]> {
  const [event] = await database
    .select({ dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, input.familyEventId),
        eq(schema.familyEvents.familyId, input.familyId),
      ),
    )
    .limit(1);
  const ids = new Set<string>();
  if (event?.dutyOwnerUserId) ids.add(event.dutyOwnerUserId);

  const day = dayKeyIn(input.originalStartsAt, input.timeZone);
  const carpools = await database
    .select({
      id: schema.linqGroupCarpools.id,
      driverUserId: schema.linqGroupCarpools.driverUserId,
      pickupAt: schema.linqGroupCarpools.pickupAt,
    })
    .from(schema.linqGroupCarpools)
    .where(
      and(
        eq(schema.linqGroupCarpools.familyId, input.familyId),
        isNull(schema.linqGroupCarpools.cancelledAt),
        isNotNull(schema.linqGroupCarpools.driverUserId),
        ne(schema.linqGroupCarpools.status, 'cancelled'),
      ),
    );
  const sameDay = carpools.filter(
    (row) => row.pickupAt !== null && dayKeyIn(row.pickupAt, input.timeZone) === day,
  );
  if (sameDay.length === 1 && sameDay[0]?.driverUserId) {
    ids.add(sameDay[0].driverUserId);
  } else if (sameDay.length > 1) {
    const closest = sameDay.reduce((best, row) => {
      const bestDelta = Math.abs(
        (best.pickupAt?.getTime() ?? 0) - input.originalStartsAt.getTime(),
      );
      const rowDelta = Math.abs((row.pickupAt?.getTime() ?? 0) - input.originalStartsAt.getTime());
      return rowDelta < bestDelta ? row : best;
    });
    if (closest.driverUserId) ids.add(closest.driverUserId);
  }

  return [...ids].map((userId) => ({ userId }));
}

export async function reanchorEventReminders(
  database: Database,
  input: {
    familyId: string;
    familyEventId: string;
    startsAt: Date | null;
    cancelled: boolean;
    timeZone: string;
    now: Date;
  },
): Promise<void> {
  if (input.cancelled || input.startsAt === null) {
    await database
      .update(schema.eventReminders)
      .set({ status: 'cancelled', updatedAt: input.now })
      .where(
        and(
          eq(schema.eventReminders.familyId, input.familyId),
          eq(schema.eventReminders.eventRef, input.familyEventId),
          eq(schema.eventReminders.status, 'scheduled'),
        ),
      );
    return;
  }
  const rows = await database
    .select({
      id: schema.eventReminders.id,
      offset: schema.eventReminders.offset,
    })
    .from(schema.eventReminders)
    .where(
      and(
        eq(schema.eventReminders.familyId, input.familyId),
        eq(schema.eventReminders.eventRef, input.familyEventId),
        eq(schema.eventReminders.status, 'scheduled'),
      ),
    );
  for (const row of rows) {
    const offset = REMINDER_OFFSETS.find((item) => item === row.offset);
    if (!offset) continue;
    await database
      .update(schema.eventReminders)
      .set({
        fireAt: reminderFireAt(input.startsAt, offset, input.timeZone),
        updatedAt: input.now,
      })
      .where(eq(schema.eventReminders.id, row.id));
  }
}

export async function reanchorCarpoolReminders(
  database: Database,
  input: {
    familyId: string;
    originalStartsAt: Date;
    newStartsAt: Date | null;
    newLocation: string | null;
    cancelled: boolean;
    timeZone: string;
    now: Date;
  },
): Promise<void> {
  const day = dayKeyIn(input.originalStartsAt, input.timeZone);
  const rows = await database
    .select()
    .from(schema.linqGroupCarpools)
    .where(
      and(
        eq(schema.linqGroupCarpools.familyId, input.familyId),
        isNull(schema.linqGroupCarpools.cancelledAt),
      ),
    );
  const sameDay = rows.filter(
    (row) => row.pickupAt !== null && dayKeyIn(row.pickupAt, input.timeZone) === day,
  );
  const target =
    sameDay.length <= 1
      ? sameDay[0]
      : sameDay.reduce((best, row) => {
          const bestDelta = Math.abs(
            (best.pickupAt?.getTime() ?? 0) - input.originalStartsAt.getTime(),
          );
          const rowDelta = Math.abs(
            (row.pickupAt?.getTime() ?? 0) - input.originalStartsAt.getTime(),
          );
          return rowDelta < bestDelta ? row : best;
        });
  if (!target) return;

  if (input.cancelled) {
    await database
      .update(schema.linqGroupCarpools)
      .set({
        reminderStatus: 'skipped_cancelled',
        reminderFireAt: null,
        updatedAt: input.now,
      })
      .where(eq(schema.linqGroupCarpools.id, target.id));
    return;
  }
  if (input.newStartsAt === null) return;
  const patch: {
    pickupAt: Date;
    pickupPlace?: string;
    reminderFireAt: Date;
    reminderStatus: 'pending';
    reminderDriverSentAt: null;
    reminderGroupSentAt: null;
    updatedAt: Date;
  } = {
    pickupAt: input.newStartsAt,
    reminderFireAt: carpoolReminderFireAt(input.newStartsAt, input.timeZone),
    reminderStatus: 'pending',
    reminderDriverSentAt: null,
    reminderGroupSentAt: null,
    updatedAt: input.now,
  };
  if (input.newLocation) patch.pickupPlace = input.newLocation;
  await database
    .update(schema.linqGroupCarpools)
    .set(patch)
    .where(eq(schema.linqGroupCarpools.id, target.id));
}

/** What a try at the driver's text is written from. */
export interface DriverNotice {
  change: SpokenChange;
  kid: string | null;
  team: string | null;
  wasAt: Date | null;
  whenAt: Date | null;
  place: string | null;
}

type DriverEvent = Pick<
  typeof schema.familyEvents.$inferSelect,
  'title' | 'startsAt' | 'location' | 'deletedAt'
>;

export function driverNotice(
  change: schema.TeamScheduleChange,
  event: DriverEvent,
  kid: string | null,
): DriverNotice {
  const cancelled = change.changeKind === 'cancel' || event.deletedAt !== null;
  return {
    change: change.changeKind,
    kid,
    team: event.title,
    wasAt: change.originalStartsAt,
    whenAt: cancelled ? null : (change.newStartsAt ?? event.startsAt),
    place: change.newLocation ?? event.location,
  };
}

export async function notifyDrivers(
  database: Database,
  input: DriverNotice & {
    changeId: string;
    familyId: string;
    drivers: readonly TeamScheduleDriver[];
    now: Date;
  },
  ports: DriverNotifyPorts,
): Promise<void> {
  if (teamScheduleSendReceiptEnabled()) {
    const { changeId, familyId, drivers, now, ...notice } = input;
    for (const driver of drivers) {
      const key = driverLegKey(changeId, driver.userId);
      // A redelivered effects run: the first try was made, so the sweep owns this leg.
      if ((await driverAttempts(database, key)).length > 0) continue;
      await sendDriverAttempt(
        database,
        { key, familyId, userId: driver.userId },
        notice,
        { attempt: 1, previous: null },
        ports,
        now,
      );
    }
    return;
  }
  for (const driver of input.drivers) {
    const text = await ports.composeDriver({
      userId: driver.userId,
      change: input.change,
      kid: input.kid,
      team: input.team,
      wasAt: input.wasAt,
      whenAt: input.whenAt,
      place: input.place,
    });
    if (text === null) {
      console.info(
        { familyId: input.familyId, outcome: 'driver_unwritten' },
        'team schedule: driver text unwritten',
      );
      continue;
    }
    const [membership] = await database
      .select({ familyId: schema.familyMembers.familyId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, driver.userId))
      .limit(1);
    const driverFamilyId = membership?.familyId ?? input.familyId;
    const verdict = await ports.gate({
      familyId: driverFamilyId,
      parentUserId: driver.userId,
      now: input.now,
    });
    if (!verdict.allowed) {
      console.info(
        { familyId: driverFamilyId, reason: verdict.reason },
        'team schedule: driver held by the outbound gate',
      );
      continue;
    }
    const door = await resolveMessagingDoor(database, driver.userId, {
      excludeChatId: await familyGroupChatId(database, driverFamilyId),
    });
    const channel = door.channel === 'imessage' ? 'imessage' : 'sms';
    const chatId = door.channel === 'imessage' ? door.chatId : null;
    if (door.channel === 'imessage' && !chatId) {
      console.info(
        { familyId: driverFamilyId, outcome: 'no_chat' },
        'team schedule: driver has no 1:1 chat',
      );
      continue;
    }
    const [claimed] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: driverFamilyId,
        parentUserId: driver.userId,
        channel,
        direction: 'out',
        category: PROACTIVE_CATEGORY.plan_check_in,
        templateKey: TEAM_SCHEDULE_DRIVER_TEMPLATE_KEY,
        providerChatId: chatId,
        status: acceptedStatus(channel),
        sentAt: input.now,
      })
      .returning({ id: schema.channelMessages.id });
    if (!claimed) continue;
    try {
      let providerMessageId: string;
      if (chatId) {
        ({ providerMessageId } = await sendLinqChatMessage({ chatId, text }));
      } else {
        const to = await ports.resolvePhone(database, driver.userId);
        if (!to) {
          await database
            .update(schema.channelMessages)
            .set({ status: 'failed', errorCode: 'no_send_target' })
            .where(eq(schema.channelMessages.id, claimed.id));
          continue;
        }
        ({ providerMessageId } = await sendResolvingNewChat(ports.transport, {
          to,
          body: withOptOut(text, verdict.optOut),
        }));
      }
      await database
        .update(schema.channelMessages)
        .set(
          channel === 'imessage'
            ? { providerMessageId, channel: 'imessage', providerChatId: chatId }
            : { providerMessageId },
        )
        .where(eq(schema.channelMessages.id, claimed.id));
      await ports.threadMessage(database, {
        familyId: driverFamilyId,
        parentUserId: driver.userId,
        body: text,
      });
    } catch (err) {
      const code = readSendRefusal(err)?.code ?? 'unknown';
      await database
        .update(schema.channelMessages)
        .set(failedSendPatch(code))
        .where(eq(schema.channelMessages.id, claimed.id));
      console.error({ familyId: driverFamilyId, code }, 'team schedule: driver send refused');
    }
  }
}

/**
 * VIL-734 · the driver text with TEAM_SCHEDULE_SEND_RECEIPT_ENABLED on.
 *
 * Each try is its own ledger row under `<leg key>:<n>`, and that unique key is the claim, so
 * two runs cannot make one try twice. The row reads `failed / send_in_flight` until Linq
 * answers: only Linq's accept writes an accepted status and `sent_at`. A failed try goes again
 * on the reminder backoff (VIL-730), each time a fresh model compose through the gate, and
 * the last try pages #ops.
 *
 * A fresh compose has new words, so only Linq's idempotency key keeps a driver from reading
 * the change twice. A try that may have landed (a timeout, a network error, any 5xx, a 2xx
 * with an unreadable receipt, a run that died mid-send) fixes the leg's key and door: every
 * later try goes under that key, and if the door has moved the leg closes instead, because
 * Linq's key may not reach across doors. Only a definite refusal leaves the next try a new
 * key. A text Linq accepted is never sent again, even if a receipt later reports it failed:
 * that row keeps Linq's id, and the delivery-health rate page is what reports receipts.
 * Nothing is ever sent in place of the model's text.
 */
const DRIVER_IN_FLIGHT = DUTY_SEND_IN_FLIGHT;
const DRIVER_UNWRITTEN = 'unwritten';

/** Longer than any one Linq call: an unanswered try this old belongs to a dead run. */
const DRIVER_IN_FLIGHT_STALE_MS = 10 * 60_000;

/** Past the whole backoff and a night of quiet hours. */
const DRIVER_RETRY_LOOKBACK_MS = 24 * 60 * 60_000;

/** A retry still held this late would leave the sweep unseen: it closes and pages instead. */
const DRIVER_RETRY_GIVE_UP_MS = DRIVER_RETRY_LOOKBACK_MS - 60 * 60_000;

/** Each retry is a model call, and the drain runs this leg before the queues. */
const DRIVER_RETRY_MAX_PER_TICK = 5;

/** No new compose starts past this, so a slow model cannot hold up the queues behind it. */
export const DRIVER_RETRY_BUDGET_MS = 20_000;

/** One compose can ask the model several times, so the client's timeout does not bound it. */
export const DRIVER_RETRY_COMPOSE_BOUND_MS = 30_000;

/** No try follows a row carrying one of these. */
const DRIVER_CLOSED_CODES: ReadonlySet<string> = new Set([
  SEND_RETRIES_EXHAUSTED,
  'no_chat',
  'no_send_target',
]);

type DriverUnsentReason =
  | 'send_refused'
  | 'send_unconfirmed'
  | 'unwritten'
  | 'event_started'
  | 'held_too_long';

interface DriverLeg {
  key: string;
  /** The family whose schedule changed: its audit trail records the leg. */
  familyId: string;
  userId: string;
}

/** The first try that may have landed: its Linq key and the chat it went to, if any. */
interface MayHaveLanded {
  key: string;
  chatId: string | null;
}

/** The newest try of a leg still open: its row, its code, and how many tries there were. */
interface OpenAttempt {
  id: string;
  code: string;
  attempts: number;
  landed: MayHaveLanded | null;
}

type DriverLegStep =
  | { kind: 'idle' | 'closed' | 'in_flight' | 'waiting' }
  | { kind: 'exhausted' | 'due'; open: OpenAttempt };

type DriverLegOutcome = 'sent' | 'retrying' | 'closed' | 'waiting' | 'held' | 'lost';

export type DriverRetrySummary =
  | { skipped: 'flag_off' }
  | { sent: number; retrying: number; closed: number; waiting: number; failed: number };

function driverLegKey(changeId: string, userId: string): string {
  return `${TEAM_SCHEDULE_DRIVER_TEMPLATE_KEY}:${changeId}:${userId}`;
}

function attemptKeys(legKey: string): string[] {
  return Array.from({ length: COMPOSE_HOLD_MAX_ATTEMPTS }, (_, index) => `${legKey}:${index + 1}`);
}

function attemptRows(database: Database, keys: string[]) {
  return database
    .select({
      id: schema.channelMessages.id,
      dedupeKey: schema.channelMessages.dedupeKey,
      errorCode: schema.channelMessages.errorCode,
      providerMessageId: schema.channelMessages.providerMessageId,
      providerChatId: schema.channelMessages.providerChatId,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(inArray(schema.channelMessages.dedupeKey, keys));
}

type DriverAttemptRow = Awaited<ReturnType<typeof attemptRows>>[number];
type DriverAttempt = DriverAttemptRow & { dedupeKey: string };

function inAttemptOrder(
  keys: readonly string[],
  rows: readonly DriverAttemptRow[],
): DriverAttempt[] {
  return keys.flatMap((key) =>
    rows.flatMap((row) => (row.dedupeKey === key ? [{ ...row, dedupeKey: key }] : [])),
  );
}

async function driverAttempts(database: Database, legKey: string): Promise<DriverAttempt[]> {
  const keys = attemptKeys(legKey);
  return inAttemptOrder(keys, await attemptRows(database, keys));
}

/**
 * Every leg of this change with a try on the ledger, whoever drives today: a leg outlives
 * its driver being reassigned. A driver is a family adult or someone seated in its group.
 */
async function driverLegsOnLedger(
  database: Database,
  change: Pick<schema.TeamScheduleChange, 'id' | 'familyId'>,
  drivers: readonly TeamScheduleDriver[],
): Promise<Array<{ userId: string; attempts: DriverAttempt[] }>> {
  const members = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, change.familyId));
  const seated = await database
    .select({ userId: schema.linqGroupMembers.userId })
    .from(schema.linqGroupMembers)
    .where(eq(schema.linqGroupMembers.familyId, change.familyId));
  const legs = [...new Set([...drivers, ...members, ...seated].map((row) => row.userId))].map(
    (userId) => ({ userId, keys: attemptKeys(driverLegKey(change.id, userId)) }),
  );
  const rows = await attemptRows(
    database,
    legs.flatMap((leg) => leg.keys),
  );
  return legs.flatMap(({ userId, keys }) => {
    const attempts = inAttemptOrder(keys, rows);
    return attempts.length > 0 ? [{ userId, attempts }] : [];
  });
}

function driverLegStep(attempts: readonly DriverAttempt[], now: Date): DriverLegStep {
  const latest = attempts.at(-1);
  if (!latest) return { kind: 'idle' };
  if (attempts.some((row) => row.providerMessageId !== null)) return { kind: 'closed' };
  const code = latest.errorCode;
  if (code === null || DRIVER_CLOSED_CODES.has(code)) return { kind: 'closed' };
  if (
    code === DRIVER_IN_FLIGHT &&
    now.getTime() - latest.createdAt.getTime() < DRIVER_IN_FLIGHT_STALE_MS
  ) {
    return { kind: 'in_flight' };
  }
  const first = attempts.find((row) => mayHaveLanded(row.errorCode));
  const open = {
    id: latest.id,
    code,
    attempts: attempts.length,
    landed: first ? { key: first.dedupeKey, chatId: first.providerChatId } : null,
  };
  const hold = nextComposeHold(attempts.length - 1, latest.createdAt);
  if (hold.action === 'exhausted') return { kind: 'exhausted', open };
  return now < hold.nextTryAt ? { kind: 'waiting' } : { kind: 'due', open };
}

/**
 * A leg that ended on this adult's own standing: they stopped Hale, gave no consent, left no
 * number, left the household, or sent a text Hale still has not read. The row is theirs alone.
 * As a family row it would tell every other parent seat about this adult's stop, their leaving
 * or their unread text.
 */
function driverUnreachableAudit(
  familyId: string,
  userId: string,
  after: { reason: string; attempts: number },
) {
  return {
    familyId,
    actor: 'system',
    actionTaken: 'team_schedule_driver_unreachable',
    audience: userId,
    targetTable: 'users',
    targetId: userId,
    after,
  };
}

/** A draft that could not be used is the model's failure, not a Linq refusal. */
function unsentPageFor(open: OpenAttempt): DriverUnsentReason {
  if (open.landed) return 'send_unconfirmed';
  return open.code === DRIVER_UNWRITTEN || open.code === GARBLED_TEXT
    ? 'unwritten'
    : 'send_refused';
}

/** Only the run that flips the row writes the audit row and pages. */
async function closeDriverLeg(
  database: Database,
  leg: DriverLeg,
  open: OpenAttempt,
  close: { code: string; reason: string; page: DriverUnsentReason | null; ownStanding?: boolean },
  pager: OpsPager,
): Promise<'closed'> {
  const after = { reason: close.reason, attempts: open.attempts };
  const ownFamilyId = close.ownStanding ? await driverFamily(database, leg) : null;
  const won = await database.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.channelMessages)
      .set({ errorCode: close.code })
      .where(
        and(
          eq(schema.channelMessages.id, open.id),
          eq(schema.channelMessages.status, 'failed'),
          eq(schema.channelMessages.errorCode, open.code),
        ),
      )
      .returning({ id: schema.channelMessages.id });
    if (!row) return false;
    await tx.insert(schema.auditLog).values(
      ownFamilyId
        ? driverUnreachableAudit(ownFamilyId, leg.userId, after)
        : {
            familyId: leg.familyId,
            actor: 'system',
            actionTaken: 'team_schedule_driver_unsent',
            targetTable: 'channel_messages',
            targetId: open.id,
            after,
          },
    );
    return true;
  });
  if (!won) return 'closed';
  console.error(
    { familyId: leg.familyId, reason: close.reason, attempts: open.attempts },
    'team schedule: driver text not sent, no further try',
  );
  if (close.page) {
    await pager.page({
      site: 'team_schedule_driver_unsent',
      facts: { reason: close.page },
      count: 1,
    });
  }
  return 'closed';
}

/** A failed try goes back on the backoff, or on the last try closes the leg and pages. */
async function holdDriverLeg(
  database: Database,
  leg: DriverLeg,
  open: OpenAttempt,
  pager: OpsPager,
  now: Date,
): Promise<'retrying' | 'closed'> {
  if (nextComposeHold(open.attempts - 1, now).action === 'exhausted') {
    return closeDriverLeg(
      database,
      leg,
      open,
      { code: SEND_RETRIES_EXHAUSTED, reason: open.code, page: unsentPageFor(open) },
      pager,
    );
  }
  await database.insert(schema.auditLog).values({
    familyId: leg.familyId,
    actor: 'system',
    actionTaken: 'team_schedule_driver_send_failed',
    targetTable: 'channel_messages',
    targetId: open.id,
    after: { attempt: open.attempts, reason: open.code },
  });
  console.warn(
    { familyId: leg.familyId, reason: open.code, attempt: open.attempts },
    'team schedule: driver text not sent, will try again',
  );
  return 'retrying';
}

/**
 * What a gate hold does to an open retry. A hold that clears by itself waits: the sweep offers
 * the leg again until it would leave the sweep's window, which closes it and pages. An unread
 * opt-out is one of those, because a real stop shows up on a later tick as `not_enrolled`.
 * `ownStanding` is about this one adult, so the row that closes the leg is theirs alone. A
 * `Record`, so a new hold reason has to say which it is.
 */
const RETRY_HOLDS: Record<ProactiveHoldReason, { waits: boolean; ownStanding: boolean }> = {
  quiet_hours: { waits: true, ownStanding: false },
  sends_paused: { waits: true, ownStanding: false },
  opt_out_unread: { waits: true, ownStanding: true },
  not_enrolled: { waits: false, ownStanding: true },
  no_watch_consent: { waits: false, ownStanding: true },
};

async function settleHeldRetry(
  database: Database,
  leg: DriverLeg,
  open: OpenAttempt,
  reason: ProactiveHoldReason,
  pager: OpsPager,
  lastChance: boolean,
): Promise<'waiting' | 'closed'> {
  const hold = RETRY_HOLDS[reason];
  if (hold.waits && !lastChance) return 'waiting';
  return closeDriverLeg(
    database,
    leg,
    open,
    {
      code: SEND_RETRIES_EXHAUSTED,
      reason: `held:${reason}`,
      page: hold.waits ? 'held_too_long' : null,
      ownStanding: hold.ownStanding,
    },
    pager,
  );
}

async function settleFailedDriverSend(
  database: Database,
  leg: DriverLeg,
  claim: { id: string; attempt: number; tried: MayHaveLanded; landed: MayHaveLanded | null },
  err: unknown,
  pager: OpsPager,
  now: Date,
): Promise<'retrying' | 'closed'> {
  const code = dutyFailureCode(err);
  await database
    .update(schema.channelMessages)
    .set({ errorCode: code })
    .where(eq(schema.channelMessages.id, claim.id));
  const open = {
    id: claim.id,
    code,
    attempts: claim.attempt,
    landed: claim.landed ?? (mayHaveLanded(code) ? claim.tried : null),
  };
  return holdDriverLeg(database, leg, open, pager, now);
}

async function sendDriverAttempt(
  database: Database,
  leg: DriverLeg,
  notice: DriverNotice,
  turn: { attempt: number } & ({ previous: null } | { previous: OpenAttempt; startsAt: Date }),
  ports: DriverNotifyPorts,
  now: Date,
): Promise<DriverLegOutcome> {
  if (!turn.previous && !(await stillInHousehold(database, leg))) {
    return leaveRemovedDriver(database, leg, null, ports.pager);
  }
  const driverFamilyId = await driverFamily(database, leg);
  const door = await resolveMessagingDoor(database, leg.userId, {
    excludeChatId: await familyGroupChatId(database, driverFamilyId),
  });
  const channel = door.channel === 'imessage' ? 'imessage' : 'sms';
  const chatId = door.channel === 'imessage' ? door.chatId : null;
  const to = door.channel === 'imessage' ? null : await ports.resolvePhone(database, leg.userId);
  const target: { chatId: string } | { to: string } | null = chatId
    ? { chatId }
    : to
      ? { to }
      : null;
  const landed = turn.previous?.landed ?? null;
  if (turn.previous && landed && landed.chatId !== chatId) {
    return closeDriverLeg(
      database,
      leg,
      turn.previous,
      { code: SEND_RETRIES_EXHAUSTED, reason: 'door_moved', page: 'send_unconfirmed' },
      ports.pager,
    );
  }
  const attemptKey = `${leg.key}:${turn.attempt}`;
  const sendKey = landed?.key ?? attemptKey;
  const writeAttempt = (errorCode: string) =>
    database
      .insert(schema.channelMessages)
      .values({
        familyId: driverFamilyId,
        parentUserId: leg.userId,
        channel,
        direction: 'out',
        category: PROACTIVE_CATEGORY.plan_check_in,
        templateKey: TEAM_SCHEDULE_DRIVER_TEMPLATE_KEY,
        dedupeKey: attemptKey,
        providerChatId: chatId,
        status: 'failed',
        errorCode,
        // Not `now`: a batch's start can be minutes old, and an old stamp reads as a dead run.
        createdAt: ports.clock(),
      })
      .onConflictDoNothing()
      .returning({ id: schema.channelMessages.id });

  if (!target) {
    const code = door.channel === 'imessage' ? 'no_chat' : 'no_send_target';
    const [row] = await writeAttempt(code);
    if (!row) return 'lost';
    await database.insert(schema.auditLog).values(
      driverUnreachableAudit(driverFamilyId, leg.userId, {
        reason: code,
        attempts: turn.attempt,
      }),
    );
    console.info({ familyId: driverFamilyId, outcome: code }, 'team schedule: driver unreachable');
    return 'closed';
  }

  const text = await ports.composeDriver({
    userId: leg.userId,
    ...notice,
    ...(turn.previous ? { signal: AbortSignal.timeout(DRIVER_RETRY_COMPOSE_BOUND_MS) } : {}),
  });
  // A compose can take half a minute, and the household can take them out in that time.
  if (!(await stillInHousehold(database, leg))) {
    return leaveRemovedDriver(database, leg, turn.previous, ports.pager);
  }
  if (text === null) {
    const [row] = await writeAttempt(DRIVER_UNWRITTEN);
    if (!row) return 'lost';
    const open = { id: row.id, code: DRIVER_UNWRITTEN, attempts: turn.attempt, landed };
    return holdDriverLeg(database, leg, open, ports.pager, now);
  }
  const verdict = await ports.gate({
    familyId: driverFamilyId,
    parentUserId: leg.userId,
    now,
  });
  if (!verdict.allowed) {
    console.info(
      { familyId: driverFamilyId, reason: verdict.reason },
      'team schedule: driver held by the outbound gate',
    );
    if (!turn.previous) return 'held';
    return settleHeldRetry(database, leg, turn.previous, verdict.reason, ports.pager, false);
  }
  if (turn.previous && ports.clock() >= turn.startsAt) {
    return closeDriverLeg(
      database,
      leg,
      turn.previous,
      { code: SEND_RETRIES_EXHAUSTED, reason: 'event_started', page: 'event_started' },
      ports.pager,
    );
  }

  const [claimed] = await writeAttempt(DRIVER_IN_FLIGHT);
  if (!claimed) return 'lost';
  let sent: ResolvedOutbound;
  try {
    sent =
      'chatId' in target
        ? await ports.sendChat({ chatId: target.chatId, text, sendKey })
        : await sendResolvingNewChat(ports.transport, {
            to: target.to,
            body: withOptOut(text, verdict.optOut),
            sendKey,
          });
  } catch (err) {
    return settleFailedDriverSend(
      database,
      leg,
      {
        id: claimed.id,
        attempt: turn.attempt,
        tried: { key: attemptKey, chatId },
        landed,
      },
      err,
      ports.pager,
      now,
    );
  }
  const carried = sent.transport === 'imessage' ? 'imessage' : channel;
  const acceptedAt = ports.clock();
  await database.transaction(async (tx) => {
    await tx
      .update(schema.channelMessages)
      .set({
        status: acceptedStatus(carried),
        errorCode: null,
        sentAt: acceptedAt,
        providerMessageId: sent.providerMessageId,
        channel: carried,
        providerChatId: chatId ?? sent.chatId ?? null,
      })
      .where(eq(schema.channelMessages.id, claimed.id));
    await tx.insert(schema.auditLog).values({
      familyId: leg.familyId,
      actor: 'system',
      actionTaken: 'team_schedule_driver_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { attempt: turn.attempt, channel: carried },
    });
  });
  try {
    await ports.threadMessage(database, {
      familyId: driverFamilyId,
      parentUserId: leg.userId,
      body: text,
    });
  } catch (err) {
    // It went out: a missing thread line must not read as a failed send or stop the next driver.
    console.error(
      { familyId: driverFamilyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: driver text sent, not threaded',
    );
  }
  return 'sent';
}

/**
 * Whether this household still has this adult. The duty and carpool columns outlive every way
 * out of it, and the outbound gate reads only the adult's own consent, so someone with a Hale
 * household of their own passes it after this family took them out. A family row says they
 * are in. A group seat says so only for a caregiver or other family, and only if it was granted
 * after this adult's latest departure from this family: `departCoParent` ends the family row and
 * no seat, so a co-parent who left keeps a live parent seat here and in any shared group, and a
 * caregiver promoted to co-parent keeps the caregiver seat from before.
 */
async function stillInHousehold(database: Database, leg: DriverLeg): Promise<boolean> {
  const [member] = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, leg.familyId),
        eq(schema.familyMembers.userId, leg.userId),
      ),
    )
    .limit(1);
  if (member) return true;
  const [seat] = await database
    .select({ id: schema.linqGroupMembers.id })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.familyId, leg.familyId),
        eq(schema.linqGroupMembers.userId, leg.userId),
        isNull(schema.linqGroupMembers.removedAt),
        inArray(schema.linqGroupMembers.role, ['caregiver', 'other_family']),
        notExists(
          database
            .select({ id: schema.auditLog.id })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.familyId, leg.familyId),
                eq(schema.auditLog.actionTaken, 'co_parent_departed'),
                eq(schema.auditLog.targetId, leg.userId),
                gte(schema.auditLog.occurredAt, schema.linqGroupMembers.createdAt),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return seat !== undefined;
}

/**
 * This adult is out of the household. A retry ends on a row that is theirs alone, so nothing
 * on the family's record mentions them. A first try has no row to close and writes none.
 */
async function leaveRemovedDriver(
  database: Database,
  leg: DriverLeg,
  previous: OpenAttempt | null,
  pager: OpsPager,
): Promise<DriverLegOutcome> {
  if (!previous) {
    console.info(
      { familyId: leg.familyId, outcome: 'driver_not_in_household' },
      'team schedule: driver is no longer in the household',
    );
    return 'held';
  }
  return closeDriverLeg(
    database,
    leg,
    previous,
    { code: SEND_RETRIES_EXHAUSTED, reason: 'superseded', page: null, ownStanding: true },
    pager,
  );
}

async function driverFamily(database: Database, leg: DriverLeg): Promise<string> {
  const [membership] = await database
    .select({ familyId: schema.familyMembers.familyId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, leg.userId))
    .limit(1);
  return membership?.familyId ?? leg.familyId;
}

/** The calendar still says what this change said: a retry never texts a stale time. */
function changeStillStands(change: schema.TeamScheduleChange, event: DriverEvent): boolean {
  if (change.changeKind === 'cancel') return event.deletedAt !== null;
  if (event.deletedAt !== null) return false;
  if (change.newStartsAt && event.startsAt.getTime() !== change.newStartsAt.getTime()) {
    return false;
  }
  return change.newLocation === null || event.location === change.newLocation;
}

async function retryDriverLeg(
  database: Database,
  leg: DriverLeg,
  open: OpenAttempt,
  context: {
    change: schema.TeamScheduleChange;
    event: DriverEvent & { childId: string | null };
  },
  ports: DriverNotifyPorts,
  now: Date,
  budget: { composes: number },
): Promise<DriverLegOutcome> {
  const { change, event } = context;
  if (!changeStillStands(change, event)) {
    return closeDriverLeg(
      database,
      leg,
      open,
      { code: SEND_RETRIES_EXHAUSTED, reason: 'superseded', page: null },
      ports.pager,
    );
  }
  const startsAt =
    change.changeKind === 'cancel'
      ? change.originalStartsAt
      : (change.newStartsAt ?? event.startsAt);
  if (startsAt <= now) {
    return closeDriverLeg(
      database,
      leg,
      open,
      { code: SEND_RETRIES_EXHAUSTED, reason: 'event_started', page: 'event_started' },
      ports.pager,
    );
  }
  // Before the compose, so a night of quiet hours costs no model calls.
  const verdict = await ports.gate({
    familyId: await driverFamily(database, leg),
    parentUserId: leg.userId,
    now,
  });
  if (!verdict.allowed) {
    const sinceChange = now.getTime() - (change.effectsAppliedAt ?? change.createdAt).getTime();
    return settleHeldRetry(
      database,
      leg,
      open,
      verdict.reason,
      ports.pager,
      sinceChange >= DRIVER_RETRY_GIVE_UP_MS,
    );
  }
  // Spent only on a real compose, so a held leg never takes a slot from one that can go.
  if (budget.composes === 0) return 'waiting';
  if (ports.clock().getTime() - now.getTime() >= DRIVER_RETRY_BUDGET_MS) return 'waiting';
  budget.composes -= 1;

  const [child] = event.childId
    ? await database
        .select({ name: schema.children.name })
        .from(schema.children)
        .where(eq(schema.children.id, event.childId))
        .limit(1)
    : [undefined];
  return sendDriverAttempt(
    database,
    leg,
    driverNotice(change, event, child?.name ?? null),
    { attempt: open.attempts + 1, previous: open, startsAt },
    ports,
    now,
  );
}

/**
 * The drain's minute tick: every driver leg still open is closed, left to wait, or tried
 * again. A leg with no try on the ledger is not this sweep's: the effects run owns the first.
 */
export async function retryTeamScheduleDrivers(
  database: Database,
  input: { now: Date; portsFor: (familyId: string) => DriverNotifyPorts },
): Promise<DriverRetrySummary> {
  if (!teamScheduleSendReceiptEnabled()) return { skipped: 'flag_off' };
  const since = new Date(input.now.getTime() - DRIVER_RETRY_LOOKBACK_MS);
  const changes = await database
    .select()
    .from(schema.teamScheduleChanges)
    .where(
      or(
        gte(schema.teamScheduleChanges.effectsAppliedAt, since),
        and(
          isNull(schema.teamScheduleChanges.effectsAppliedAt),
          gte(schema.teamScheduleChanges.createdAt, since),
        ),
      ),
    )
    .orderBy(
      sql`coalesce(${schema.teamScheduleChanges.newStartsAt}, ${schema.teamScheduleChanges.originalStartsAt})`,
    );
  const summary = { sent: 0, retrying: 0, closed: 0, waiting: 0, failed: 0 };
  const budget = { composes: DRIVER_RETRY_MAX_PER_TICK };
  for (const change of changes) {
    // The feature's own kill switch stops what is queued, not only what is new.
    if (!teamScheduleChangesActive(change.familyId)) continue;
    const [event] = await database
      .select({
        title: schema.familyEvents.title,
        startsAt: schema.familyEvents.startsAt,
        location: schema.familyEvents.location,
        deletedAt: schema.familyEvents.deletedAt,
        childId: schema.familyEvents.childId,
      })
      .from(schema.familyEvents)
      .where(
        and(
          eq(schema.familyEvents.id, change.familyEventId),
          eq(schema.familyEvents.familyId, change.familyId),
        ),
      )
      .limit(1);
    if (!event) continue;
    const drivers = await loadAffectedDrivers(database, {
      familyId: change.familyId,
      familyEventId: change.familyEventId,
      originalStartsAt: change.originalStartsAt,
      timeZone: change.timeZone,
    });
    const stillDriving = new Set(drivers.map((driver) => driver.userId));
    for (const { userId, attempts } of await driverLegsOnLedger(database, change, drivers)) {
      const leg = {
        key: driverLegKey(change.id, userId),
        familyId: change.familyId,
        userId,
      };
      try {
        const step = driverLegStep(attempts, input.now);
        if (step.kind === 'waiting') summary.waiting += 1;
        if (step.kind !== 'exhausted' && step.kind !== 'due') continue;
        const ports = input.portsFor(change.familyId);
        let outcome: DriverLegOutcome;
        if (!(await stillInHousehold(database, leg))) {
          outcome = await leaveRemovedDriver(database, leg, step.open, ports.pager);
        } else if (!stillDriving.has(userId)) {
          outcome = await closeDriverLeg(
            database,
            leg,
            step.open,
            { code: SEND_RETRIES_EXHAUSTED, reason: 'superseded', page: null },
            ports.pager,
          );
        } else if (step.kind === 'exhausted') {
          outcome = await closeDriverLeg(
            database,
            leg,
            step.open,
            {
              code: SEND_RETRIES_EXHAUSTED,
              reason: step.open.code,
              page: unsentPageFor(step.open),
            },
            ports.pager,
          );
        } else {
          outcome = await retryDriverLeg(
            database,
            leg,
            step.open,
            { change, event },
            ports,
            input.now,
            budget,
          );
        }
        if (outcome !== 'held' && outcome !== 'lost') summary[outcome] += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(
          { familyId: change.familyId, err: err instanceof Error ? err.name : 'unknown' },
          'team schedule: driver retry failed, left for a later tick',
        );
      }
    }
  }
  return summary;
}

export function productionDriverNotifyPorts(
  database: Database,
  transport: ChannelTransport,
  composeDriver: DriverNotifyPorts['composeDriver'],
): DriverNotifyPorts {
  return {
    composeDriver,
    gate: (request) =>
      assertProactiveSendAllowed(
        { ...request, kind: 'plan_check_in' },
        buildOutboundGatePorts(database),
      ),
    resolvePhone: resolveSendablePhone,
    transport,
    sendChat: sendLinqChatMessage,
    threadMessage: threadProactiveMessage,
    clock: () => new Date(),
    pager: {
      async page(page) {
        const { pageOps } = await import('~/lib/monitoring/failure-page');
        return pageOps(database, page);
      },
    },
  };
}

async function familyGroupChatId(database: Database, familyId: string): Promise<string | null> {
  const [row] = await database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.linqGroupChatId ?? null;
}
