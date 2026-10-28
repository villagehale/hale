import { type Database, schema } from '@hale/db';
import { type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';
import { realHumanPhone } from '~/lib/channel/linq/group-coparent';
import { groupMemberByPhone } from '~/lib/channel/linq/group-membership';
import type { GroupLineSend } from '~/lib/channel/linq/group-onboarding-voice';
import { groupTurnReadContext } from '~/lib/channel/linq/group-turn-reader';
import type { LinqInboundText } from '~/lib/channel/linq/payload';
import { familyLanguage, primaryParentId } from '~/lib/channel/linq/roster-ask';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { confirmFacts } from './facts';
import { postGroupReminderLine } from './line';
import { planReminderTurn } from './plan';
import { GROUP_REMINDER_RECENT_LINES, type GroupReminderReader, readerNow } from './read';
import { askerTimeZone, directQuiet, directReachable, groupQuiet, liveSeats } from './standing';
import {
  armReminders,
  cancelReminders,
  inboundAlreadyRecorded,
  insertPendingReminders,
  openRemindersFor,
} from './store';
import { type GroupReminderVoice, whenFact } from './voice';

/**
 * VIL-448 (T26) — "Remind me ..." from anyone in the group.
 *
 * Runs in the group door on a turn the AI turn reader already sent to the coach. The
 * reminder reader decides whether the whole message is about reminders. Anything else, a
 * failed read, or nothing usable leaves the turn to the coach exactly as before.
 * Otherwise this turn owns the reply: the reminders are written `pending`, the
 * confirmation is composed and posted in the group, and only once it lands are they
 * armed. A confirmation the model could not write sends nothing and arms nothing.
 */

export const GROUP_REMINDER_CONFIRM_TEMPLATE = 'linq:group_reminder_confirm';

export type GroupReminderPass =
  | 'no_reader'
  | 'not_seated'
  | 'replay'
  | 'unread'
  | 'not_reminders'
  | 'nothing_usable';

export type GroupReminderHandled =
  | 'group_reminder_set'
  | 'group_reminder_asked_when'
  | 'group_reminder_cancelled'
  | 'group_reminder_unwritten'
  | 'group_reminder_not_sent'
  | 'already_answered';

export type GroupReminderTurn =
  | { handled: false; reason: GroupReminderPass }
  | { handled: true; outcome: GroupReminderHandled };

export interface GroupReminderTurnPorts {
  now: Date;
  /** Null: no model is configured. The turn goes on to the coach, by name. */
  reader: GroupReminderReader | null;
  /** Null: no model is configured. Nothing is sent and nothing is armed. */
  voice: GroupReminderVoice | null;
  send?: GroupLineSend;
  /** The door's own record of this inbound and its audit. Null: it was already recorded. */
  recordInbound(
    message: LinqInboundText,
    owner: { familyId: string; userId: string },
  ): Promise<string | null>;
}

function pass(reason: GroupReminderPass): GroupReminderTurn {
  console.info({ outcome: `group_reminder_pass_${reason}` }, 'group reminder: left to the coach');
  return { handled: false, reason };
}

async function pageUnsent(reason: string): Promise<void> {
  const page = await postOpsSlack(
    `Hale group reminder: a confirmation was not sent (${reason}). Nothing was set and nothing went to the group.`,
  );
  console.warn({ reason, page }, 'group reminder: confirmation not sent');
}

/** Who an open reminder is for, as the reader is shown it. */
function openFor(
  row: schema.GroupReminder,
  askerPhoneHash: string,
  seats: readonly { phoneHash: string; firstName: string | null }[],
): string | null {
  if (row.forKind === 'everyone') return 'everyone';
  if (row.forPhoneHash === askerPhoneHash) return 'sender';
  const seat = row.forPhoneHash
    ? seats.find((candidate) => candidate.phoneHash === row.forPhoneHash)
    : undefined;
  return seat?.firstName ?? row.forName;
}

export async function takeGroupReminderTurn(
  database: Database,
  message: LinqInboundText,
  ports: GroupReminderTurnPorts,
): Promise<GroupReminderTurn> {
  if (!ports.reader) return pass('no_reader');
  const phone = realHumanPhone(message.senderHandle);
  if (!phone) return pass('not_seated');
  const member = await groupMemberByPhone(database, message.chatId, phone);
  if (!member) return pass('not_seated');
  if (await inboundAlreadyRecorded(database, message.messageId)) return pass('replay');

  const now = ports.now;
  const familyId = member.familyId;
  const phoneHash = phoneBlindIndex(phone);
  const seats = await liveSeats(database, message.chatId);
  const askerSeat = seats.find((seat) => seat.phoneHash === phoneHash) ?? null;
  const timeZone = await askerTimeZone(database, familyId, member.userId);
  const open = await openRemindersFor(database, { chatId: message.chatId, phoneHash, now });
  const openRefs = new Map(open.map((row, index) => [`r${index + 1}`, row.id]));
  const context = await groupTurnReadContext(database, {
    familyId,
    chatId: message.chatId,
    senderUserId: member.userId,
  });

  const reading = await ports.reader.read({
    message: message.text,
    sender: context.senderName,
    people: seats
      .filter((seat) => seat.phoneHash !== phoneHash)
      .map((seat) => seat.firstName)
      .filter((name): name is string => name !== null),
    recent: context.recent.slice(-GROUP_REMINDER_RECENT_LINES).map((line) => ({ ...line })),
    now: readerNow(now, timeZone),
    open: open.map((row, index) => ({
      ref: `r${index + 1}`,
      for: openFor(row, phoneHash, seats),
      what: row.what ?? '',
      when: whenFact(row.deliverAt, timeZone),
    })),
  });
  if (!reading) return pass('unread');
  if (reading.request !== 'reminders') return pass('not_reminders');

  const wantsDirect = reading.set.some((ask) => ask.for === 'sender' && ask.where !== 'group');
  const reachable =
    wantsDirect && member.haleCustomer
      ? await directReachable(database, familyId, member.userId)
      : false;
  const plan = planReminderTurn({
    reading,
    now,
    timeZone,
    asker: {
      userId: member.userId,
      phoneHash,
      firstName: context.senderName,
      haleCustomer: member.haleCustomer,
      directReachable: reachable,
    },
    seats,
    groupQuiet: await groupQuiet(database, familyId, seats),
    directQuiet: reachable
      ? { timeZone, windows: await directQuiet(database, member.userId, askerSeat) }
      : null,
    openRefs,
  });
  if (plan.set.length === 0 && plan.needsTime.length === 0 && plan.cancelIds.length === 0) {
    return pass('nothing_usable');
  }

  const recorded = await ports.recordInbound(message, { familyId, userId: member.userId });
  if (!recorded) return { handled: true, outcome: 'already_answered' };

  const language: ReplyLanguage =
    acceptReplyLanguage(reading.language) ?? (await familyLanguage(database, familyId));
  const pending = await insertPendingReminders(
    database,
    plan.set.map((planned, ordinal) => ({
      familyId,
      chatId: message.chatId,
      sourceMessageId: message.messageId,
      ordinal,
      askedByUserId: member.userId,
      askedByPhoneHash: phoneHash,
      forKind: planned.forKind,
      forUserId: planned.forUserId,
      forPhoneHash: planned.forPhoneHash,
      forName: planned.forName,
      what: planned.what,
      language,
      askedForAt: planned.askedFor,
      deliverAt: planned.deliverAt,
      delivery: planned.delivery,
    })),
  );
  const pendingIds = pending.map((row) => row.id);
  const cancelling = open.filter((row) => plan.cancelIds.includes(row.id));

  const facts = confirmFacts({
    language,
    asker: context.senderName,
    memberWords: message.text,
    now,
    timeZone,
    plan,
    cancelled: cancelling,
  });

  const text = ports.voice ? await ports.voice.write(facts) : null;
  if (!text) {
    await cancelReminders(database, {
      ids: pendingIds,
      reason: 'confirm_unwritten',
      actor: 'system',
      now,
    });
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'group_reminder_unwritten',
      targetTable: 'channel_messages',
      targetId: recorded,
      after: { kind: 'confirm', voice: ports.voice ? 'model_failed' : 'voice_unavailable' },
    });
    await pageUnsent(ports.voice ? 'model_failed' : 'voice_unavailable');
    return { handled: true, outcome: 'group_reminder_unwritten' };
  }

  const ledgerUserId = (await primaryParentId(database, familyId)) ?? member.userId;
  const posted = await postGroupReminderLine(database, {
    familyId,
    ledgerUserId,
    chatId: message.chatId,
    text,
    replyTo: message.messageId,
    templateKey: GROUP_REMINDER_CONFIRM_TEMPLATE,
    dedupeKey: `${GROUP_REMINDER_CONFIRM_TEMPLATE}:${message.messageId}`,
    now,
    send: ports.send,
  });
  if (posted.outcome !== 'sent') {
    await cancelReminders(database, {
      ids: pendingIds,
      reason: 'confirm_not_sent',
      actor: 'system',
      now,
    });
    return {
      handled: true,
      outcome: posted.outcome === 'already_sent' ? 'already_answered' : 'group_reminder_not_sent',
    };
  }

  await armReminders(database, pendingIds, now);
  if (pending.length > 0) {
    await database.insert(schema.auditLog).values(
      pending.map((row) => ({
        familyId,
        actor: member.userId,
        actionTaken: 'group_reminder_set',
        targetTable: 'group_reminders',
        targetId: row.id,
        after: {
          delivery: row.delivery,
          forKind: row.forKind,
          deliverAt: row.deliverAt.toISOString(),
          moved: plan.set[row.ordinal]?.moved ?? null,
        },
      })),
    );
  }
  const cancelled = await cancelReminders(database, {
    ids: cancelling.map((row) => row.id),
    reason: 'asked',
    actor: member.userId,
    now,
  });

  const conversationId = await resolveOrCreateNoteConversation(
    familyId,
    channelGroupNoteKey(message.chatId),
    database,
  );
  await appendMessage(conversationId, 'user', message.text, database);
  await appendMessage(conversationId, 'assistant', text, database);

  console.info(
    {
      outcome: 'group_reminder_turn',
      set: pending.length,
      cancelled: cancelled.length,
      askedWhen: plan.needsTime.length,
      direct: pending.filter((row) => row.delivery === 'direct').length,
    },
    'group reminder: confirmed in the group',
  );
  if (pending.length > 0) return { handled: true, outcome: 'group_reminder_set' };
  if (cancelled.length > 0) return { handled: true, outcome: 'group_reminder_cancelled' };
  return { handled: true, outcome: 'group_reminder_asked_when' };
}
