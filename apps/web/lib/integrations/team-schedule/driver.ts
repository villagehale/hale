import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { SENT_STATUSES, acceptedStatus } from '~/lib/channel/ledger';
import { carpoolReminderFireAt } from '~/lib/channel/linq/carpool-cadence';
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
  refusalStopsRetry,
  sendLinqChatMessage,
  sendMayHaveLanded,
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
      const bestDelta = Math.abs((best.pickupAt?.getTime() ?? 0) - input.originalStartsAt.getTime());
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
 * answers: only Linq's accept writes an accepted status and `sent_at`. A refusal goes again
 * on the reminder backoff (VIL-730), each time a fresh model compose through the gate, and
 * the last try pages #ops. A send with no answer may have landed, so it is never made again.
 * Nothing is ever sent in place of the model's text.
 */
const DRIVER_IN_FLIGHT = 'send_in_flight';
const DRIVER_UNCONFIRMED = 'send_unconfirmed';
const DRIVER_UNWRITTEN = 'unwritten';

/** Longer than any one Linq call: an unanswered try this old belongs to a dead run. */
const DRIVER_IN_FLIGHT_STALE_MS = 10 * 60_000;

/** Past the whole backoff and a night of quiet hours. */
const DRIVER_RETRY_LOOKBACK_MS = 24 * 60 * 60_000;

/** Each retry is a model call, and the drain runs this leg before the queues. */
const DRIVER_RETRY_MAX_PER_TICK = 5;

/** No try follows a row carrying one of these. */
const DRIVER_CLOSED_CODES: ReadonlySet<string> = new Set([
  DRIVER_UNCONFIRMED,
  SEND_RETRIES_EXHAUSTED,
  'no_chat',
  'no_send_target',
]);

type DriverUnsentReason = 'send_refused' | 'send_unconfirmed' | 'unwritten' | 'event_started';

interface DriverLeg {
  key: string;
  /** The family whose schedule changed: its audit trail records the leg. */
  familyId: string;
  userId: string;
}

/** The newest try of a leg still open: its row, its code, and how many tries there were. */
interface OpenAttempt {
  id: string;
  code: string;
  attempts: number;
}

type DriverLegStep =
  | { kind: 'idle' | 'closed' | 'in_flight' | 'waiting' }
  | { kind: 'died' | 'exhausted' | 'due'; open: OpenAttempt };

type DriverLegOutcome = 'sent' | 'retrying' | 'closed' | 'waiting' | 'held' | 'lost';

export type DriverRetrySummary =
  | { skipped: 'flag_off' }
  | { sent: number; retrying: number; closed: number; waiting: number; failed: number };

function driverLegKey(changeId: string, userId: string): string {
  return `${TEAM_SCHEDULE_DRIVER_TEMPLATE_KEY}:${changeId}:${userId}`;
}

async function driverAttempts(database: Database, legKey: string) {
  const keys = Array.from(
    { length: COMPOSE_HOLD_MAX_ATTEMPTS },
    (_, index) => `${legKey}:${index + 1}`,
  );
  const rows = await database
    .select({
      id: schema.channelMessages.id,
      dedupeKey: schema.channelMessages.dedupeKey,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(inArray(schema.channelMessages.dedupeKey, keys));
  return keys.flatMap((key) => rows.filter((row) => row.dedupeKey === key));
}

function driverLegStep(
  attempts: Awaited<ReturnType<typeof driverAttempts>>,
  now: Date,
): DriverLegStep {
  const latest = attempts.at(-1);
  if (!latest) return { kind: 'idle' };
  const accepted: readonly string[] = SENT_STATUSES;
  if (attempts.some((row) => accepted.includes(row.status))) return { kind: 'closed' };
  const code = latest.errorCode;
  if (code === null || DRIVER_CLOSED_CODES.has(code)) return { kind: 'closed' };
  const open = { id: latest.id, code, attempts: attempts.length };
  if (code === DRIVER_IN_FLIGHT) {
    const age = now.getTime() - latest.createdAt.getTime();
    return age >= DRIVER_IN_FLIGHT_STALE_MS ? { kind: 'died', open } : { kind: 'in_flight' };
  }
  const hold = nextComposeHold(attempts.length - 1, latest.createdAt);
  if (hold.action === 'exhausted') return { kind: 'exhausted', open };
  return now < hold.nextTryAt ? { kind: 'waiting' } : { kind: 'due', open };
}

/** Only the run that flips the row writes the audit row and pages. */
async function closeDriverLeg(
  database: Database,
  leg: DriverLeg,
  open: OpenAttempt,
  close: { code: string; reason: string; page: DriverUnsentReason | null },
  pager: OpsPager,
): Promise<'closed'> {
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
    await tx.insert(schema.auditLog).values({
      familyId: leg.familyId,
      actor: 'system',
      actionTaken: 'team_schedule_driver_unsent',
      targetTable: 'channel_messages',
      targetId: open.id,
      after: { reason: close.reason, attempts: open.attempts },
    });
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
  page: DriverUnsentReason,
  pager: OpsPager,
  now: Date,
): Promise<'retrying' | 'closed'> {
  if (nextComposeHold(open.attempts - 1, now).action === 'exhausted') {
    return closeDriverLeg(
      database,
      leg,
      open,
      { code: SEND_RETRIES_EXHAUSTED, reason: open.code, page },
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

/** Quiet hours wait: the sweep offers it again. Any other hold ends the retry, unpaged. */
async function settleHeldRetry(
  database: Database,
  leg: DriverLeg,
  open: OpenAttempt,
  reason: ProactiveHoldReason,
  pager: OpsPager,
): Promise<'waiting' | 'closed'> {
  if (reason === 'quiet_hours') return 'waiting';
  return closeDriverLeg(
    database,
    leg,
    open,
    { code: SEND_RETRIES_EXHAUSTED, reason: `held:${reason}`, page: null },
    pager,
  );
}

async function settleFailedDriverSend(
  database: Database,
  leg: DriverLeg,
  claim: { id: string; attempt: number },
  err: unknown,
  pager: OpsPager,
  now: Date,
): Promise<'retrying' | 'closed'> {
  const refusal = readSendRefusal(err);
  if (!refusal || sendMayHaveLanded(err)) {
    return closeDriverLeg(
      database,
      leg,
      { id: claim.id, code: DRIVER_IN_FLIGHT, attempts: claim.attempt },
      {
        code: DRIVER_UNCONFIRMED,
        reason: refusal?.code ?? 'unrecognised',
        page: 'send_unconfirmed',
      },
      pager,
    );
  }
  await database
    .update(schema.channelMessages)
    .set({ errorCode: refusal.code })
    .where(eq(schema.channelMessages.id, claim.id));
  const open = { id: claim.id, code: refusal.code, attempts: claim.attempt };
  if (refusalStopsRetry(err)) {
    return closeDriverLeg(
      database,
      leg,
      open,
      { code: SEND_RETRIES_EXHAUSTED, reason: refusal.code, page: 'send_refused' },
      pager,
    );
  }
  return holdDriverLeg(database, leg, open, 'send_refused', pager, now);
}

async function sendDriverAttempt(
  database: Database,
  leg: DriverLeg,
  notice: DriverNotice,
  turn: { attempt: number } & ({ previous: null } | { previous: OpenAttempt; startsAt: Date }),
  ports: DriverNotifyPorts,
  now: Date,
): Promise<DriverLegOutcome> {
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
        dedupeKey: `${leg.key}:${turn.attempt}`,
        providerChatId: chatId,
        status: 'failed',
        errorCode,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.channelMessages.id });

  if (!target) {
    const code = door.channel === 'imessage' ? 'no_chat' : 'no_send_target';
    const [row] = await writeAttempt(code);
    if (!row) return 'lost';
    await database.insert(schema.auditLog).values({
      familyId: leg.familyId,
      actor: 'system',
      actionTaken: 'team_schedule_driver_unsent',
      targetTable: 'channel_messages',
      targetId: row.id,
      after: { reason: code, attempts: turn.attempt },
    });
    console.info({ familyId: driverFamilyId, outcome: code }, 'team schedule: driver unreachable');
    return 'closed';
  }

  const text = await ports.composeDriver({ userId: leg.userId, ...notice });
  if (text === null) {
    const [row] = await writeAttempt(DRIVER_UNWRITTEN);
    if (!row) return 'lost';
    const open = { id: row.id, code: DRIVER_UNWRITTEN, attempts: turn.attempt };
    return holdDriverLeg(database, leg, open, 'unwritten', ports.pager, now);
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
    return settleHeldRetry(database, leg, turn.previous, verdict.reason, ports.pager);
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
        ? await ports.sendChat({ chatId: target.chatId, text })
        : await sendResolvingNewChat(ports.transport, {
            to: target.to,
            body: withOptOut(text, verdict.optOut),
          });
  } catch (err) {
    return settleFailedDriverSend(
      database,
      leg,
      { id: claimed.id, attempt: turn.attempt },
      err,
      ports.pager,
      now,
    );
  }
  const carried = sent.transport === 'imessage' ? 'imessage' : channel;
  await database.transaction(async (tx) => {
    await tx
      .update(schema.channelMessages)
      .set({
        status: acceptedStatus(carried),
        errorCode: null,
        sentAt: now,
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
  if (!verdict.allowed) return settleHeldRetry(database, leg, open, verdict.reason, ports.pager);
  // Spent only on a real compose, so a held leg never takes a slot from one that can go.
  if (budget.composes === 0) return 'waiting';
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
    for (const driver of drivers) {
      const leg = {
        key: driverLegKey(change.id, driver.userId),
        familyId: change.familyId,
        userId: driver.userId,
      };
      try {
        const step = driverLegStep(await driverAttempts(database, leg.key), input.now);
        if (step.kind === 'waiting') summary.waiting += 1;
        if (step.kind !== 'died' && step.kind !== 'exhausted' && step.kind !== 'due') continue;
        const ports = input.portsFor(change.familyId);
        let outcome: DriverLegOutcome;
        if (step.kind === 'died') {
          outcome = await closeDriverLeg(
            database,
            leg,
            step.open,
            { code: DRIVER_UNCONFIRMED, reason: DRIVER_UNCONFIRMED, page: 'send_unconfirmed' },
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
              page: step.open.code === DRIVER_UNWRITTEN ? 'unwritten' : 'send_refused',
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
