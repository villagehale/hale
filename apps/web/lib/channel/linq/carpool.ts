import { type Database, schema } from '@hale/db';
import { and, eq, isNull, lte } from 'drizzle-orm';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs-types';
import {
  type CarpoolPlanState,
  type CarpoolSender,
  applyCarpoolReading,
  markAsked,
  markReminder,
} from './carpool-apply';
import { decideCarpoolReminder, decideCarpoolTurn, localMinutesIn } from './carpool-cadence';
import { type CarpoolReader, readingFromTapback, sharedCarpoolReader } from './carpool-reading';
import { type CarpoolComposer, createCarpoolComposer } from './carpool-voice';
import { linqGroupCarpoolEnabled } from './config';
import { deliverLinqGroupNotice } from './group';
import { groupMemberByPhone, readGroupMembership } from './group-membership';
import { sendLinqChatMessage } from '~/lib/channel/outbound-transport';

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
  | { handled: false; outcome: 'flag_off' | 'no_family' | 'unchanged' }
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

async function livePlan(
  database: Database,
  chatId: string,
): Promise<
  (CarpoolPlanState & { id: string; familyId: string; askMessageId: string | null }) | null
> {
  const [row] = await database
    .select()
    .from(schema.linqGroupCarpools)
    .where(
      and(
        eq(schema.linqGroupCarpools.chatId, chatId),
        isNull(schema.linqGroupCarpools.cancelledAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...rowToPlan(row), id: row.id, familyId: row.familyId, askMessageId: row.askMessageId };
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

  const existing = await livePlan(database, input.chatId);
  const sender = await senderOf(database, input);
  const reader = input.reader ?? sharedCarpoolReader();
  const reading = await reader.read({
    text: input.text,
    senderName: sender.name,
    memberNames: (membership?.members ?? []).map((member) => member.userId),
    currentDriver: existing?.driverName ?? null,
    nowIso: input.now.toISOString(),
    timeZone: sender.timezone,
    recent: [],
  });
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
    senderName: string | null;
    messageId: string;
    reactionType: string | null;
    now: Date;
    send?: CarpoolGroupSend;
    voice?: CarpoolComposer;
  },
): Promise<CarpoolTurnOutcome> {
  if (!linqGroupCarpoolEnabled()) return { handled: false, outcome: 'flag_off' };
  const existing = await livePlan(database, input.chatId);
  const reading = readingFromTapback({
    reactionType: input.reactionType,
    reactorName: input.senderName,
    onAsk: Boolean(existing?.askMessageId && existing.askMessageId === input.messageId),
  });
  if (!reading) return { handled: false, outcome: 'unchanged' };
  return considerCarpoolTurn(database, {
    chatId: input.chatId,
    familyId: input.familyId,
    senderHandle: input.senderHandle,
    senderUserId: null,
    senderName: input.senderName,
    text: '',
    now: input.now,
    send: input.send,
    voice: input.voice,
    reader: { read: async () => reading },
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

    const voice = input.voice ?? createCarpoolComposer({ database, familyId: row.familyId });
    const facts = voiceFacts(plan, null);
    const groupLine = await voice.compose({ kind: 'night_before_group', facts });
    if (!groupLine) {
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
    const groupSent = await deliverLinqGroupNotice(database, {
      familyId: row.familyId,
      parentUserId: plan.driverUserId ?? row.familyId,
      chatId: row.chatId,
      text: groupLine,
      templateKey: 'linq:carpool_night_before',
      now: input.now,
      send,
    });
    if (groupSent !== 'sent') {
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
    if (plan.driverHaleCustomer && plan.driverUserId && input.sendDriver) {
      const driverLine = await voice.compose({ kind: 'night_before_driver', facts });
      if (!driverLine) {
        driverSkipped = 'line_unsent';
      } else {
        const driver = await input.sendDriver({ userId: plan.driverUserId, text: driverLine });
        if (!driver.sent) driverSkipped = driver.skipped;
        else {
          await database
            .update(schema.linqGroupCarpools)
            .set({ reminderDriverSentAt: input.now, updatedAt: input.now })
            .where(eq(schema.linqGroupCarpools.id, row.id));
        }
      }
    } else {
      driverSkipped = plan.driverHaleCustomer ? 'no_driver_send' : 'driver_not_customer';
    }

    await persistPlan(database, {
      chatId: row.chatId,
      familyId: row.familyId,
      plan: markReminder(plan, 'sent'),
      existingId: row.id,
      askMessageId: row.askMessageId,
      now: input.now,
    });
    await database
      .update(schema.linqGroupCarpools)
      .set({ reminderGroupSentAt: input.now, updatedAt: input.now })
      .where(eq(schema.linqGroupCarpools.id, row.id));
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
