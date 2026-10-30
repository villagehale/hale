import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import {
  PROACTIVE_CATEGORY,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import {
  createOutboundTransport,
  failedSendPatch,
  readSendRefusal,
  sendLinqChatMessage,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs-types';
import { dayKeyIn } from '~/lib/plan/spine';
import {
  type CarpoolPlanState,
  type CarpoolReading,
  type CarpoolSender,
  applyCarpoolReading,
  carpoolPlanKey,
  markAsked,
  markReminder,
  parsePickupAt,
} from './carpool-apply';
import { decideCarpoolReminder, decideCarpoolTurn, localMinutesIn } from './carpool-cadence';
import { type CarpoolReader, readingFromTapback, sharedCarpoolReader } from './carpool-reading';
import { type CarpoolComposer, createCarpoolComposer } from './carpool-voice';
import { linqGroupCarpoolEnabled } from './config';
import { deliverLinqGroupNotice } from './group';
import { groupMemberByPhone, readGroupMembership } from './group-membership';

/**
 * VIL-445 (T16) — persist who is driving and send the night-before reminder.
 *
 * Facts come from the group thread. Private calendars and inboxes are not read.
 * A missing composer line is `group_line_unsent`: nothing is sent, no fallback.
 */

export type CarpoolGroupSend = (input: { chatId: string; text: string }) => Promise<{
  providerMessageId: string;
}>;

export type CarpoolDriverSend = (input: {
  userId: string;
  text: string;
}) => Promise<{ sent: true; providerMessageId: string } | { sent: false; skipped: string }>;

export type CarpoolTurnOutcome =
  | { handled: false; outcome: 'flag_off' | 'no_family' | 'unchanged' | 'unknown_sender' }
  | {
      handled: true;
      outcome:
        | 'carpool_recorded'
        | 'carpool_asked'
        | 'carpool_line_unsent'
        | 'carpool_cancelled'
        | 'carpool_swapped';
      notice?: 'sent' | 'not_sent';
    };

export type CarpoolReminderRun = {
  considered: number;
  fired: number;
  held: number;
  skipped: number;
};

export interface CarpoolTurnInput {
  chatId: string;
  familyId: string;
  senderHandle: string;
  senderUserId: string | null;
  senderName: string | null;
  text: string;
  now: Date;
  addressed?: boolean;
  language?: string | null;
  send?: CarpoolGroupSend;
  reader?: CarpoolReader;
  voice?: CarpoolComposer;
  /** Provider id of this inbound, so the transcript read leaves it out. */
  messageId?: string | null;
  /** Test seam; production reads the chat's recent inbound lines. */
  recent?: readonly { from: 'hale' | 'member'; text: string }[];
}

function defaultGroupSend(notice: { chatId: string; text: string }) {
  return sendLinqChatMessage(notice);
}

function haleCustomerFlag(value: string | boolean): boolean {
  return value === true || value === 'true';
}

function rowToPlan(row: typeof schema.linqGroupCarpools.$inferSelect): CarpoolPlanState {
  return {
    planKey: row.planKey,
    eventLabel: row.eventLabel,
    pickupAt: row.pickupAt,
    pickupPlace: row.pickupPlace,
    kids: row.kids,
    driverName: row.driverName,
    driverUserId: row.driverUserId,
    driverHaleCustomer: haleCustomerFlag(row.driverHaleCustomer),
    driverTimezone: row.driverTimezone,
    status: row.status,
    askedForDriverAt: row.askedForDriverAt,
    reminderStatus: row.reminderStatus,
    reminderFireAt: row.reminderFireAt,
  };
}

type LivePlan = CarpoolPlanState & { id: string; familyId: string; askMessageId: string | null };

async function livePlans(database: Database, chatId: string): Promise<LivePlan[]> {
  const rows = await database
    .select()
    .from(schema.linqGroupCarpools)
    .where(
      and(
        eq(schema.linqGroupCarpools.chatId, chatId),
        isNull(schema.linqGroupCarpools.cancelledAt),
      ),
    );
  return rows.map((row) => ({
    ...rowToPlan(row),
    id: row.id,
    familyId: row.familyId,
    askMessageId: row.askMessageId,
  }));
}

/**
 * Devin #936 — a chat can plan more than one ride. Match the reading to a plan
 * by its event/day key. A reading with no event or day of its own belongs to the
 * only open plan, or to none when several are open (nothing is overwritten).
 */
export function pickCarpoolPlan<P extends CarpoolPlanState>(
  plans: readonly P[],
  reading: CarpoolReading,
  timeZone: string,
): P | null | 'ambiguous' {
  const pickupAt = parsePickupAt(reading.pickupAtIso);
  const event = reading.eventLabel?.trim() || null;
  if (!pickupAt && !event) {
    if (plans.length === 0) return null;
    if (plans.length === 1) return plans[0] ?? null;
    return 'ambiguous';
  }
  const tz = (plan: P) => plan.driverTimezone || timeZone;
  if (pickupAt && event) {
    const exact = plans.find((plan) => plan.planKey === carpoolPlanKey(event, pickupAt, tz(plan)));
    if (exact) return exact;
  }
  const norm = (value: string | null) => (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const dayOf = (plan: P) => plan.planKey.split(':')[0];
  const candidates = plans.filter((plan) => {
    const dayOk = pickupAt ? dayOf(plan) === dayKeyIn(pickupAt, tz(plan)) : true;
    const eventOk = event ? norm(plan.eventLabel) === norm(event) : true;
    return dayOk && eventOk;
  });
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length > 1) return 'ambiguous';
  // A reschedule: same event, new day. Only when exactly one open ride has it.
  if (event && pickupAt) {
    const sameEvent = plans.filter((plan) => norm(plan.eventLabel) === norm(event));
    if (sameEvent.length === 1) return sameEvent[0] ?? null;
    if (sameEvent.length > 1) return 'ambiguous';
  }
  return null;
}

async function recentGroupLines(
  database: Database,
  input: { chatId: string; now: Date; messageId?: string | null },
): Promise<{ from: 'hale' | 'member'; text: string }[]> {
  if (typeof database.select !== 'function') return [];
  try {
    const rows = await database
      .select({
        body: schema.channelMessages.body,
        direction: schema.channelMessages.direction,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.providerChatId, input.chatId),
          isNotNull(schema.channelMessages.body),
          lt(schema.channelMessages.sentAt, input.now),
        ),
      )
      .orderBy(desc(schema.channelMessages.sentAt))
      .limit(9);
    return rows
      .filter((row) => !input.messageId || row.providerMessageId !== input.messageId)
      .slice(0, 8)
      .reverse()
      .map((row) => ({
        from: row.direction === 'out' ? ('hale' as const) : ('member' as const),
        text: row.body ?? '',
      }))
      .filter((line) => line.text.trim().length > 0);
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'carpool: recent group lines were not read',
    );
    return [];
  }
}

async function persistPlan(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    plan: CarpoolPlanState;
    existingId: string | null;
    askMessageId?: string | null;
    now: Date;
  },
): Promise<string> {
  const values = {
    chatId: input.chatId,
    familyId: input.familyId,
    planKey: input.plan.planKey,
    eventLabel: input.plan.eventLabel,
    pickupAt: input.plan.pickupAt,
    pickupPlace: input.plan.pickupPlace,
    kids: input.plan.kids,
    driverName: input.plan.driverName,
    driverUserId: input.plan.driverUserId,
    driverHaleCustomer: input.plan.driverHaleCustomer ? 'true' : 'false',
    driverTimezone: input.plan.driverTimezone,
    status: input.plan.status,
    askedForDriverAt: input.plan.askedForDriverAt,
    askMessageId: input.askMessageId ?? null,
    reminderFireAt: input.plan.reminderFireAt,
    reminderStatus: input.plan.reminderStatus,
    cancelledAt: input.plan.status === 'cancelled' ? input.now : null,
    updatedAt: input.now,
  };
  if (input.existingId) {
    await database
      .update(schema.linqGroupCarpools)
      .set(values)
      .where(eq(schema.linqGroupCarpools.id, input.existingId));
    return input.existingId;
  }
  const [inserted] = await database
    .insert(schema.linqGroupCarpools)
    .values(values)
    .returning({ id: schema.linqGroupCarpools.id });
  if (!inserted) throw new Error('linq carpool: insert returned no row');
  return inserted.id;
}

async function audit(
  database: Database,
  familyId: string,
  actionTaken: string,
  after: Record<string, unknown>,
  targetId: string,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'linq_group_carpools',
    targetId,
    after,
  });
}

function voiceFacts(
  plan: CarpoolPlanState,
  language: string | null | undefined,
): Parameters<CarpoolComposer['compose']>[0]['facts'] {
  const pickupTime = plan.pickupAt
    ? plan.pickupAt.toLocaleString('en-CA', {
        timeZone: plan.driverTimezone,
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  return {
    driver: plan.driverName,
    kids: plan.kids,
    pickupTime,
    pickupPlace: plan.pickupPlace,
    event: plan.eventLabel,
    language: language ?? null,
  };
}

async function senderOf(
  database: Database,
  input: Pick<CarpoolTurnInput, 'chatId' | 'senderHandle' | 'senderUserId' | 'senderName'>,
): Promise<CarpoolSender> {
  let seated: Awaited<ReturnType<typeof groupMemberByPhone>> = null;
  try {
    seated = await groupMemberByPhone(database, input.chatId, input.senderHandle);
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'carpool: membership lookup did not finish',
    );
  }
  let timezone = 'America/Toronto';
  if (input.senderUserId || seated?.userId) {
    const [user] = await database
      .select({ timezone: schema.users.timezone, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, seated?.userId ?? input.senderUserId ?? ''))
      .limit(1);
    timezone = user?.timezone || timezone;
    return {
      userId: seated?.userId ?? input.senderUserId,
      name: input.senderName ?? user?.name?.trim().split(/\s+/)[0] ?? null,
      haleCustomer: seated?.haleCustomer ?? Boolean(input.senderUserId),
      timezone,
    };
  }
  return {
    userId: null,
    name: input.senderName,
    haleCustomer: false,
    timezone,
  };
}

export async function considerCarpoolTurn(
  database: Database,
  input: CarpoolTurnInput,
): Promise<CarpoolTurnOutcome> {
  if (!linqGroupCarpoolEnabled()) return { handled: false, outcome: 'flag_off' };
  const send = input.send ?? defaultGroupSend;
  const membership = await readGroupMembership(database, input.chatId);
  const familyId = membership?.familyId ?? input.familyId;
  if (!familyId) return { handled: false, outcome: 'no_family' };

  const plans = await livePlans(database, input.chatId);
  const sender = await senderOf(database, input);
  // Devin #936 (security) — only a verified family member or a seated roster
  // member can claim, swap, or cancel a ride. Unknown handles change nothing.
  if (!sender.userId) return { handled: false, outcome: 'unknown_sender' };
  const reader = input.reader ?? sharedCarpoolReader();
  const recent = input.recent ?? (await recentGroupLines(database, input));
  const reading = await reader.read({
    text: input.text,
    senderName: sender.name,
    memberNames: (membership?.members ?? []).map((member) => member.userId),
    currentDriver: plans.length === 1 ? (plans[0]?.driverName ?? null) : null,
    nowIso: input.now.toISOString(),
    timeZone: sender.timezone,
    recent,
  });
  const picked = pickCarpoolPlan(plans, reading, sender.timezone);
  // Several open rides and the message names none of them: change nothing.
  if (picked === 'ambiguous') return { handled: false, outcome: 'unchanged' };
  const existing = picked;
  const next = applyCarpoolReading(existing, reading, sender, input.now);
  if (!next) return { handled: false, outcome: 'unchanged' };
  if (reading.intent === 'chatter' || reading.intent === 'unclear') {
    return { handled: false, outcome: 'unchanged' };
  }

  let turn = decideCarpoolTurn({
    intent: reading.intent,
    confidence: reading.confidence,
    plan: next,
    addressed: input.addressed === true,
  });
  if (turn.speak === 'addressed_status' && !next.driverName && !next.askedForDriverAt) {
    turn = { speak: 'ask_driver' };
  }

  let stored = next;
  let askMessageId: string | null = existing?.askMessageId ?? null;
  let notice: 'sent' | 'not_sent' | undefined;
  let outcome: Extract<CarpoolTurnOutcome, { handled: true }>['outcome'] =
    reading.intent === 'cancel'
      ? 'carpool_cancelled'
      : reading.intent === 'driver_swap' ||
          (reading.intent === 'driver_claim' &&
            Boolean(existing?.driverName) &&
            existing?.driverName !== next.driverName)
        ? 'carpool_swapped'
        : 'carpool_recorded';

  if (turn.speak === 'ask_driver') {
    const voice = input.voice ?? createCarpoolComposer({ database, familyId });
    const line = await voice.compose({
      kind: 'ask_driver',
      facts: voiceFacts(next, input.language),
    });
    if (!line) {
      const id = await persistPlan(database, {
        chatId: input.chatId,
        familyId,
        plan: next,
        existingId: existing?.id ?? null,
        askMessageId,
        now: input.now,
      });
      await audit(database, familyId, 'group_line_unsent', { kind: 'ask_driver' }, id);
      return { handled: true, outcome: 'carpool_line_unsent', notice: 'not_sent' };
    }
    let providerMessageId: string | null = null;
    const sent = await deliverLinqGroupNotice(database, {
      familyId,
      parentUserId: sender.userId ?? familyId,
      chatId: input.chatId,
      text: line,
      templateKey: 'linq:carpool_ask_driver',
      now: input.now,
      send: async (notice) => {
        const result = await send(notice);
        providerMessageId = result.providerMessageId;
        return result;
      },
    });
    notice = sent === 'sent' ? 'sent' : 'not_sent';
    if (sent === 'sent') {
      stored = markAsked(next, input.now);
      askMessageId = providerMessageId;
      outcome = 'carpool_asked';
    }
  }

  const id = await persistPlan(database, {
    chatId: input.chatId,
    familyId,
    plan: stored,
    existingId: existing?.id ?? null,
    askMessageId,
    now: input.now,
  });
  await audit(
    database,
    familyId,
    outcome === 'carpool_cancelled' ? 'linq_carpool_cancelled' : 'linq_carpool_updated',
    {
      intent: reading.intent,
      driverName: stored.driverName,
      reminderStatus: stored.reminderStatus,
    },
    id,
  );
  return { handled: true, outcome, ...(notice ? { notice } : {}) };
}

export async function considerCarpoolTapback(
  database: Database,
  input: {
    chatId: string;
    familyId: string;
    senderHandle: string;
    senderUserId?: string | null;
    senderName: string | null;
    messageId: string;
    reactionType: string | null;
    now: Date;
    send?: CarpoolGroupSend;
    voice?: CarpoolComposer;
  },
): Promise<CarpoolTurnOutcome> {
  if (!linqGroupCarpoolEnabled()) return { handled: false, outcome: 'flag_off' };
  const plans = await livePlans(database, input.chatId);
  const asked = plans.find((plan) => plan.askMessageId && plan.askMessageId === input.messageId);
  // Devin #936 — resolve who reacted from their handle before reading the tapback.
  const sender = await senderOf(database, {
    chatId: input.chatId,
    senderHandle: input.senderHandle,
    senderUserId: input.senderUserId ?? null,
    senderName: input.senderName,
  });
  const reading = readingFromTapback({
    reactionType: input.reactionType,
    reactorName: sender.name,
    onAsk: Boolean(asked),
  });
  if (!reading || !asked) return { handled: false, outcome: 'unchanged' };
  // The tapback is on one ride's ask: key the reading to that ride.
  const keyed: CarpoolReading = {
    ...reading,
    eventLabel: asked.eventLabel,
    pickupAtIso: asked.pickupAt ? asked.pickupAt.toISOString() : null,
  };
  return considerCarpoolTurn(database, {
    chatId: input.chatId,
    familyId: input.familyId,
    senderHandle: input.senderHandle,
    senderUserId: sender.userId,
    senderName: sender.name,
    text: '',
    now: input.now,
    send: input.send,
    voice: input.voice,
    recent: [],
    reader: { read: async () => keyed },
  });
}

export async function runCarpoolReminders(
  database: Database,
  input: {
    now: Date;
    send?: CarpoolGroupSend;
    sendDriver?: CarpoolDriverSend;
    voice?: CarpoolComposer;
  },
): Promise<CarpoolReminderRun> {
  const summary: CarpoolReminderRun = { considered: 0, fired: 0, held: 0, skipped: 0 };
  if (!linqGroupCarpoolEnabled()) return summary;
  const send = input.send ?? defaultGroupSend;
  const sendDriver = input.sendDriver ?? createCarpoolDriverSend(database, input.now);

  const due = await database
    .select()
    .from(schema.linqGroupCarpools)
    .where(
      and(
        eq(schema.linqGroupCarpools.reminderStatus, 'pending'),
        lte(schema.linqGroupCarpools.reminderFireAt, input.now),
      ),
    );

  for (const row of due) {
    summary.considered += 1;
    const plan = rowToPlan(row);
    const timeZone = plan.driverTimezone;
    const quietStart = DEFAULT_LOOP_PREFS.quietHoursStart;
    const quiet = isWithinQuietHours(
      input.now,
      timeZone,
      quietStart,
      DEFAULT_LOOP_PREFS.quietHoursEnd,
    );
    const quietStartMin = Number(quietStart.slice(0, 2)) * 60 + Number(quietStart.slice(3, 5) || 0);
    const decision = decideCarpoolReminder({
      plan,
      now: input.now,
      localMinutes: localMinutesIn(input.now, timeZone),
      quiet,
      quietStartMin,
      timeZone,
    });

    if (decision.action === 'wait') continue;
    if (decision.action === 'hold') {
      const next = markReminder(plan, 'held_quiet');
      await persistPlan(database, {
        chatId: row.chatId,
        familyId: row.familyId,
        plan: { ...next, reminderStatus: 'pending' },
        existingId: row.id,
        askMessageId: row.askMessageId,
        now: input.now,
      });
      await audit(
        database,
        row.familyId,
        'linq_carpool_reminder_held',
        { reason: 'quiet_hours' },
        row.id,
      );
      summary.held += 1;
      continue;
    }
    if (decision.action === 'skip') {
      const status =
        decision.reason === 'cancelled'
          ? 'skipped_cancelled'
          : decision.reason === 'no_driver'
            ? 'skipped_no_driver'
            : 'suppressed';
      await persistPlan(database, {
        chatId: row.chatId,
        familyId: row.familyId,
        plan: markReminder(plan, status),
        existingId: row.id,
        askMessageId: row.askMessageId,
        now: input.now,
      });
      await audit(
        database,
        row.familyId,
        'linq_carpool_reminder_skipped',
        { reason: decision.reason },
        row.id,
      );
      summary.skipped += 1;
      continue;
    }

    // Devin #936 — claim the row before anything is sent, so an overlapping
    // cron run cannot read the same pending reminder and send it twice.
    const [claimed] = await database
      .update(schema.linqGroupCarpools)
      .set({ reminderStatus: 'sent', reminderGroupSentAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(schema.linqGroupCarpools.id, row.id),
          eq(schema.linqGroupCarpools.reminderStatus, 'pending'),
          isNull(schema.linqGroupCarpools.cancelledAt),
        ),
      )
      .returning({ id: schema.linqGroupCarpools.id });
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }
    const release = () =>
      database
        .update(schema.linqGroupCarpools)
        .set({ reminderStatus: 'pending', reminderGroupSentAt: null, updatedAt: input.now })
        .where(eq(schema.linqGroupCarpools.id, row.id));

    const voice = input.voice ?? createCarpoolComposer({ database, familyId: row.familyId });
    const facts = voiceFacts(plan, null);
    const groupLine = await voice.compose({ kind: 'night_before_group', facts });
    if (!groupLine) {
      await release();
      await audit(
        database,
        row.familyId,
        'group_line_unsent',
        { kind: 'night_before_group' },
        row.id,
      );
      summary.skipped += 1;
      continue;
    }
    // Devin #936 — the ledger row belongs to the covering family's parent, not
    // the driver (who may be in another family or not a customer at all).
    const ledgerUserId = await coveringParentUserId(database, row.familyId);
    if (!ledgerUserId) {
      await release();
      await audit(
        database,
        row.familyId,
        'group_line_unsent',
        { kind: 'night_before_group', notice: 'no_parent' },
        row.id,
      );
      summary.skipped += 1;
      continue;
    }
    const groupSent = await deliverLinqGroupNotice(database, {
      familyId: row.familyId,
      parentUserId: ledgerUserId,
      chatId: row.chatId,
      text: groupLine,
      templateKey: 'linq:carpool_night_before',
      now: input.now,
      send,
      // Devin #936 (security) — a proactive ride reminder is schedule content,
      // never a reply: an incomplete roster holds it.
      lineClass: 'schedule',
    });
    if (groupSent !== 'sent') {
      await release();
      await audit(
        database,
        row.familyId,
        'group_line_unsent',
        { kind: 'night_before_group', notice: groupSent },
        row.id,
      );
      summary.skipped += 1;
      continue;
    }

    let driverSkipped: string | null = null;
    if (plan.driverHaleCustomer && plan.driverUserId) {
      const driverLine = await voice.compose({ kind: 'night_before_driver', facts });
      if (!driverLine) {
        driverSkipped = 'line_unsent';
      } else {
        const driver = await sendDriver({ userId: plan.driverUserId, text: driverLine });
        if (!driver.sent) driverSkipped = driver.skipped;
        else {
          await database
            .update(schema.linqGroupCarpools)
            .set({ reminderDriverSentAt: input.now, updatedAt: input.now })
            .where(eq(schema.linqGroupCarpools.id, row.id));
        }
      }
    } else {
      driverSkipped = plan.driverHaleCustomer ? 'no_driver_user' : 'driver_not_customer';
    }

    await persistPlan(database, {
      chatId: row.chatId,
      familyId: row.familyId,
      plan: markReminder(plan, 'sent'),
      existingId: row.id,
      askMessageId: row.askMessageId,
      now: input.now,
    });
    await audit(
      database,
      row.familyId,
      'linq_carpool_reminder_sent',
      { driverSkipped, driverName: plan.driverName },
      row.id,
    );
    summary.fired += 1;
  }
  return summary;
}

async function coveringParentUserId(database: Database, familyId: string): Promise<string | null> {
  const rows = await database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const seat =
    rows.find((row) => row.role === 'primary_parent') ??
    rows.find((row) => row.role === 'co_parent');
  return seat?.userId ?? null;
}

async function familyOfUser(database: Database, userId: string): Promise<string | null> {
  const rows = await database
    .select({ familyId: schema.familyMembers.familyId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, userId));
  const seat = rows.find((row) => row.role === 'primary_parent' || row.role === 'co_parent');
  return seat?.familyId ?? null;
}

/**
 * Devin #936 — the production 1:1 driver reminder the cron was missing.
 * Gated like every proactive send (enrolment, opt-out, consent, quiet hours),
 * ledgered (claim row first) before the provider is called, and kept out of the
 * household group thread.
 */
export function createCarpoolDriverSend(
  database: Database,
  now: Date,
  makeTransport: typeof createOutboundTransport = createOutboundTransport,
): CarpoolDriverSend {
  return async ({ userId, text }) => {
    const familyId = await familyOfUser(database, userId);
    if (!familyId) return { sent: false, skipped: 'no_family' };
    const verdict = await assertProactiveSendAllowed(
      { familyId, parentUserId: userId, kind: 'plan_check_in', now },
      buildOutboundGatePorts(database),
    );
    if (!verdict.allowed) return { sent: false, skipped: verdict.reason };
    const phone = await resolveSendablePhone(database, userId);
    if (!phone) return { sent: false, skipped: 'no_send_target' };
    const [family] = await database
      .select({ chatId: schema.families.linqGroupChatId })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);
    const door = await resolveMessagingDoor(database, userId, {
      excludeChatId: family?.chatId ?? null,
    });
    const chatId = door.channel === 'imessage' ? door.chatId : null;
    if (door.channel === 'imessage' && !chatId) return { sent: false, skipped: 'no_chat' };
    const channel = door.channel === 'imessage' ? 'imessage' : 'sms';
    const [claimed] = await database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId: userId,
        channel,
        direction: 'out',
        category: PROACTIVE_CATEGORY.plan_check_in,
        templateKey: 'linq:carpool_night_before_driver',
        providerChatId: chatId,
        status: acceptedStatus(channel),
        sentAt: now,
      })
      .returning({ id: schema.channelMessages.id });
    if (!claimed) return { sent: false, skipped: 'ledger_failed' };
    let providerMessageId: string;
    try {
      if (chatId) {
        ({ providerMessageId } = await sendLinqChatMessage({ chatId, text }));
      } else {
        ({ providerMessageId } = await sendResolvingNewChat(makeTransport(), {
          to: phone,
          body: text,
        }));
      }
    } catch (err) {
      const code = readSendRefusal(err)?.code ?? 'unknown';
      await database
        .update(schema.channelMessages)
        .set(failedSendPatch(code))
        .where(eq(schema.channelMessages.id, claimed.id));
      return { sent: false, skipped: `send_failed:${code}` };
    }
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { sent: true, providerMessageId };
  };
}
