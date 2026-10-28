import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { groupAudienceAllows } from '~/lib/channel/linq/group-audience';
import type { GroupLineSend } from '~/lib/channel/linq/group-onboarding-voice';
import { primaryParentId } from '~/lib/channel/linq/roster-ask';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { threadIfParent } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { reminderFacts } from './facts';
import {
  type GroupReminderLineOutcome,
  postGroupReminderLine,
  textGroupReminderDirect,
} from './line';
import { fireDecision, inQuiet } from './policy';
import {
  type Seat,
  askerTimeZone,
  directQuiet,
  directReachable,
  groupQuiet,
  liveSeats,
  seatedCustomer,
} from './standing';
import {
  type GroupReminderRow,
  claimReminder,
  closeReminder,
  commitSend,
  dueReminders,
  releaseSend,
} from './store';
import { type GroupReminderVoice, sharedGroupReminderVoice } from './voice';

/**
 * VIL-448 (T26) — the minute tick that sends due group reminders.
 *
 * Each due row is claimed before anything is read, then checked at the moment of sending:
 * the family still holds the chat, the asker and the person it is for are still seated
 * (STOP and removal already cancelled theirs; this catches a race), the group may hear
 * it, a 1:1 is still for a Hale customer, it is not quiet hours, and a 1:1 still has
 * someone to reach. A failed check drops the reminder by name. A reminder the model could
 * not write is not sent. Once it is written the tick commits to sending it (store.ts), so
 * a STOP or a cancel that landed while it was being written still wins and nothing is
 * sent, and one that lands after the commit finds it already going out and leaves the row
 * to say so. A group line reads the group's audience again as it goes.
 *
 * The tick sends both kinds itself: a group reminder as a line in the chat, a 1:1
 * reminder as a text on Hale's 1:1 line to the asker's own verified number. A 1:1 never
 * goes through the loop's channel dispatch, which carries a household's texts into its
 * family group.
 *
 * An error mid-send, or a refusal Linq calls temporary, closes nothing: the claim goes
 * stale and a later tick takes the row again and checks everything afresh. A refusal hands
 * the commit back first, so a STOP meanwhile still takes the reminder back. A reminder
 * that keeps failing is tried at most every `SENDING_STALE_MS` and dropped as missed past
 * `LATE_LIMIT_MS`. A send that reached Linq, or may have, is never made again: its ledger
 * key holds it, and the later tick closes the reminder as sent only on Linq's message id.
 */

export const GROUP_REMINDER_TEMPLATE = 'linq:group_reminder';
export const GROUP_REMINDER_DIRECT_TEMPLATE = 'linq:group_reminder_direct';

export interface GroupReminderTickPorts {
  now: Date;
  /** Null: no model is configured. Nothing is claimed and nothing is sent. */
  voice: GroupReminderVoice | null;
  send?: GroupLineSend;
  /** Hale's 1:1 line, for a customer's own reminder. */
  oneToOne: ChannelTransport;
}

export type GroupReminderTickSummary =
  | { skipped: 'voice_unavailable' }
  | {
      due: number;
      sent: number;
      dropped: number;
      failed: number;
      /** Taken back by a STOP, a cancel or a later tick before this tick sent anything. */
      lost: number;
      /** An error mid-send: left claimed, so a later tick tries again once the claim is stale. */
      retrying: number;
    };

type FireOutcome = 'sent' | 'dropped' | 'failed' | 'lost' | 'retrying';

/** Closes the claim, or names it lost when a STOP, a cancel or a later tick took it first. */
async function close(
  database: Database,
  row: GroupReminderRow,
  input: Parameters<typeof closeReminder>[2],
): Promise<FireOutcome> {
  return (await closeReminder(database, row, input)) ? input.status : 'lost';
}

/** Taken once the text is written, just before it goes: a STOP or a cancel meanwhile wins. */
async function committed(database: Database, row: GroupReminderRow): Promise<boolean> {
  if (await commitSend(database, row)) return true;
  console.info(
    { reminderId: row.id, outcome: 'claim_lost' },
    'group reminders: taken back before the send, nothing sent',
  );
  return false;
}

const SEND_UNCONFIRMED = 'send_unconfirmed';

/** What a send under this key left on the ledger, if one was ever claimed. */
async function priorSend(database: Database, dedupeKey: string) {
  const [row] = await database
    .select({
      id: schema.channelMessages.id,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      providerMessageId: schema.channelMessages.providerMessageId,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, dedupeKey))
    .limit(1);
  return row ?? null;
}

type PriorSend = NonNullable<Awaited<ReturnType<typeof priorSend>>>;

/**
 * Closes a reminder whose send was already made, or begun: its key holds it, so it is not
 * sent again. It is sent only on Linq's message id. A send Linq refused closes failed by
 * its code. One with no answer recorded may or may not have landed, and closes failed as
 * unconfirmed, its ledger row with it.
 */
async function closeFromLedger(
  database: Database,
  row: GroupReminderRow,
  prior: PriorSend,
  now: Date,
): Promise<FireOutcome> {
  if (prior.providerMessageId) {
    return close(database, row, { status: 'sent', reason: 'already_sent', now });
  }
  if (prior.status === 'failed') {
    return close(database, row, { status: 'failed', reason: prior.errorCode ?? 'unknown', now });
  }
  await database
    .update(schema.channelMessages)
    .set({ status: 'failed', errorCode: SEND_UNCONFIRMED })
    .where(
      and(
        eq(schema.channelMessages.id, prior.id),
        isNull(schema.channelMessages.providerMessageId),
      ),
    );
  console.warn(
    { reminderId: row.id, outcome: SEND_UNCONFIRMED },
    'group reminders: a send with no answer from Linq on record, not sent again',
  );
  return close(database, row, { status: 'failed', reason: SEND_UNCONFIRMED, now });
}

/**
 * Closes a committed send by what happened to it. A sent text is threaded before the row
 * closes, so a tick that dies in between leaves a row a later tick closes from the ledger.
 */
async function settle(
  database: Database,
  row: GroupReminderRow,
  sendKey: string,
  sent: GroupReminderLineOutcome,
  now: Date,
  thread: () => Promise<unknown>,
): Promise<FireOutcome> {
  if (sent.outcome === 'held') {
    return close(database, row, { status: 'dropped', reason: 'audience_held', now });
  }
  if (sent.outcome === 'not_sent') {
    if (sent.retryable) {
      await releaseSend(database, row);
      console.warn(
        { reminderId: row.id, code: sent.code, outcome: 'retrying' },
        'group reminders: Linq refused for now, left claimed for a later tick',
      );
      return 'retrying';
    }
    return close(database, row, { status: 'failed', reason: sent.code, now });
  }
  if (sent.outcome === 'already_sent') {
    const prior = await priorSend(database, sendKey);
    return prior ? closeFromLedger(database, row, prior, now) : 'retrying';
  }
  await thread();
  await closeReminder(database, row, { status: 'sent', reason: null, now });
  return 'sent';
}

async function familyHoldsChat(database: Database, familyId: string, chatId: string) {
  const [row] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(and(eq(schema.families.id, familyId), eq(schema.families.linqGroupChatId, chatId)))
    .limit(1);
  return Boolean(row);
}

async function quietNowFor(
  database: Database,
  row: GroupReminderRow,
  seats: readonly Seat[],
  askerSeat: Seat | null,
  now: Date,
): Promise<boolean> {
  if (row.delivery === 'direct' && row.askedByUserId) {
    const timeZone = await askerTimeZone(database, row.familyId, row.askedByUserId);
    return inQuiet(now, timeZone, await directQuiet(database, row.askedByUserId, askerSeat));
  }
  const quiet = await groupQuiet(database, row.familyId, seats);
  return inQuiet(now, quiet.timeZone, quiet.windows);
}

async function pageUnwritten(): Promise<void> {
  const page = await postOpsSlack(
    'Hale group reminder: a due reminder was not sent because it could not be written. Nothing went out.',
  );
  console.warn({ page }, 'group reminder: reminder not written');
}

async function fireOne(
  database: Database,
  row: GroupReminderRow,
  ports: GroupReminderTickPorts & { voice: GroupReminderVoice },
): Promise<FireOutcome> {
  const now = ports.now;
  const templateKey =
    row.delivery === 'direct' ? GROUP_REMINDER_DIRECT_TEMPLATE : GROUP_REMINDER_TEMPLATE;
  const sendKey = `${templateKey}:${row.id}`;
  // Before every check: a send a dead tick made, or began, decides it, whatever changed since.
  const prior = await priorSend(database, sendKey);
  if (prior) return closeFromLedger(database, row, prior, now);
  const seats = await liveSeats(database, row.chatId);
  const askerSeat = seats.find((seat) => seat.phoneHash === row.askedByPhoneHash) ?? null;
  const recipientSeat = row.forPhoneHash
    ? (seats.find((seat) => seat.phoneHash === row.forPhoneHash) ?? null)
    : null;
  const groupHeld = await familyHoldsChat(database, row.familyId, row.chatId);
  const audienceAllowed =
    row.delivery === 'group'
      ? (await groupAudienceAllows(database, row.chatId, 'schedule')).allowed
      : true;
  const askerCustomer =
    row.delivery === 'direct'
      ? await seatedCustomer(database, row.chatId, row.askedByUserId)
      : true;
  const reachable =
    row.delivery === 'direct'
      ? await directReachable(database, row.familyId, row.askedByUserId)
      : true;
  const decision = fireDecision(row, {
    now,
    groupHeld,
    askerSeated: askerSeat !== null,
    recipientSeated: row.forKind === 'person' ? recipientSeat !== null : null,
    audienceAllowed,
    askerCustomer,
    quietNow: await quietNowFor(database, row, seats, askerSeat, now),
    directReachable: reachable,
  });
  if (decision.kind === 'drop') {
    return close(database, row, { status: 'dropped', reason: decision.reason, now });
  }
  if (!row.what) return close(database, row, { status: 'failed', reason: 'no_what', now });

  const timeZone = await askerTimeZone(database, row.familyId, row.askedByUserId);
  const facts = reminderFacts({
    reminder: { ...row, what: row.what },
    askerName: askerSeat?.firstName ?? null,
    recipientName: recipientSeat?.firstName ?? row.forName,
    now,
    timeZone,
  });
  const text = await ports.voice.write(facts);
  if (!text) {
    const outcome = await close(database, row, { status: 'failed', reason: 'unwritten', now });
    await pageUnwritten();
    return outcome;
  }

  if (row.delivery === 'direct') {
    const userId = row.askedByUserId;
    const to = userId ? await resolveSendablePhone(database, userId) : null;
    if (!userId || !to) {
      return close(database, row, { status: 'dropped', reason: 'direct_unreachable', now });
    }
    if (!(await committed(database, row))) return 'lost';
    const texted = await textGroupReminderDirect(database, {
      familyId: row.familyId,
      userId,
      to,
      text,
      templateKey,
      dedupeKey: sendKey,
      now,
      transport: ports.oneToOne,
    });
    return settle(database, row, sendKey, texted, now, () =>
      threadIfParent(database, { familyId: row.familyId, parentUserId: userId, body: text }),
    );
  }

  const ledgerUserId = (await primaryParentId(database, row.familyId)) ?? row.askedByUserId;
  if (!ledgerUserId) {
    return close(database, row, { status: 'failed', reason: 'no_ledger_owner', now });
  }
  if (!(await committed(database, row))) return 'lost';
  const posted = await postGroupReminderLine(database, {
    familyId: row.familyId,
    ledgerUserId,
    chatId: row.chatId,
    text,
    replyTo: row.sourceMessageId,
    templateKey,
    dedupeKey: sendKey,
    now,
    send: ports.send,
  });
  return settle(database, row, sendKey, posted, now, async () => {
    const conversationId = await resolveOrCreateNoteConversation(
      row.familyId,
      channelGroupNoteKey(row.chatId),
      database,
    );
    await appendMessage(conversationId, 'assistant', text, database);
  });
}

export async function runGroupReminderTick(
  database: Database,
  ports: GroupReminderTickPorts,
): Promise<GroupReminderTickSummary> {
  const voice = ports.voice;
  if (!voice) {
    console.warn({ outcome: 'voice_unavailable' }, 'group reminders: tick skipped');
    return { skipped: 'voice_unavailable' };
  }
  const due = await dueReminders(database, ports.now);
  const summary = {
    due: due.length,
    sent: 0,
    dropped: 0,
    failed: 0,
    lost: 0,
    retrying: 0,
  };
  for (const candidate of due) {
    const row = await claimReminder(database, candidate.id, ports.now);
    if (!row) continue;
    let outcome: FireOutcome;
    try {
      outcome = await fireOne(database, row, { ...ports, voice });
    } catch (err) {
      console.error(
        {
          reminderId: row.id,
          err: err instanceof Error ? err.name : 'unknown',
          outcome: 'retrying',
        },
        'group reminders: send failed, left claimed for a later tick',
      );
      outcome = 'retrying';
    }
    summary[outcome] += 1;
  }
  return summary;
}

/** Production wiring: the shared voice, the Linq group send, and Hale's 1:1 line. */
export function groupReminderTickPorts(now: Date): GroupReminderTickPorts {
  return {
    now,
    voice: sharedGroupReminderVoice(),
    oneToOne: createOutboundTransport(),
  };
}
