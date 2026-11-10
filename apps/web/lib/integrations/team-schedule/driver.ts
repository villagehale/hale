import { type Database, schema } from '@hale/db';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import { carpoolReminderFireAt } from '~/lib/channel/linq/carpool-cadence';
import { resolveMessagingDoor } from '~/lib/channel/messaging-door';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type ProactiveSendVerdict,
  PROACTIVE_CATEGORY,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import {
  failedSendPatch,
  readSendRefusal,
  sendLinqChatMessage,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { REMINDER_OFFSETS, reminderFireAt } from '~/lib/loop/reminders/schedule';
import { dayKeyIn } from '~/lib/plan/spine';
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
  threadMessage: typeof threadProactiveMessage;
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

export async function notifyDrivers(
  database: Database,
  input: {
    familyId: string;
    drivers: readonly TeamScheduleDriver[];
    change: SpokenChange;
    kid: string | null;
    team: string | null;
    wasAt: Date | null;
    whenAt: Date | null;
    place: string | null;
    now: Date;
  },
  ports: DriverNotifyPorts,
): Promise<void> {
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
    const door = await resolveMessagingDoor(database, driver.userId);
    const channel = door.channel === 'imessage' ? 'imessage' : 'sms';
    const chatId = door.channel === 'imessage' ? door.chatId : null;
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
    threadMessage: threadProactiveMessage,
  };
}
