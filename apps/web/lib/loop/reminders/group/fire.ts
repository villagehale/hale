import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { groupAudienceAllows } from '~/lib/channel/linq/group-audience';
import type { GroupLineSend } from '~/lib/channel/linq/group-onboarding-voice';
import { primaryParentId } from '~/lib/channel/linq/roster-ask';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { MEMBER_REMINDER_TEMPLATE_KEY } from '~/lib/loop/templates/member-reminder';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { getQueue } from '~/lib/queue';
import { reminderFacts } from './facts';
import { postGroupReminderLine } from './line';
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
  claimHeld,
  claimReminder,
  closeReminder,
  dueReminders,
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
 * not write is not sent. Once it is written the tick looks at its claim again, so a STOP
 * or a cancel that landed while it was being written still wins and nothing is sent.
 *
 * A group reminder is posted by the tick itself. A 1:1 reminder is handed to the loop's
 * channel dispatch, which owns consent, quiet hours and the ledger for 1:1 texts, and
 * closes as `queued`, not `sent`: the dispatch's ledger row says whether it went out.
 *
 * An error mid-send, or a refusal Linq calls temporary, closes nothing: the claim goes
 * stale and a later tick takes the row again and checks everything afresh, so a reminder
 * that keeps failing is tried at most every `SENDING_STALE_MS` and dropped as missed past
 * `LATE_LIMIT_MS`. A line already posted is not posted again (its ledger key), and
 * dispatch dedupes a 1:1 handoff.
 */

export const GROUP_REMINDER_TEMPLATE = 'linq:group_reminder';

export interface ChannelSendJob {
  templateKey: string;
  familyId: string;
  parentUserId: string;
  category: 'reminder';
  urgency: 'normal';
  payload: Record<string, unknown>;
  dedupeKey: string;
  channel: 'sms';
}

export interface GroupReminderTickPorts {
  now: Date;
  /** Null: no model is configured. Nothing is claimed and nothing is sent. */
  voice: GroupReminderVoice | null;
  send?: GroupLineSend;
  enqueue(job: ChannelSendJob): Promise<void>;
}

export type GroupReminderTickSummary =
  | { skipped: 'voice_unavailable' }
  | {
      due: number;
      sent: number;
      /** Handed to the channel dispatch for a 1:1 text, which decides and records the send. */
      queued: number;
      dropped: number;
      failed: number;
      /** Taken back by a STOP, a cancel or a later tick before this tick sent anything. */
      lost: number;
      /** An error mid-send: left claimed, so a later tick tries again once the claim is stale. */
      retrying: number;
    };

type FireOutcome = 'sent' | 'queued' | 'dropped' | 'failed' | 'lost' | 'retrying';

/** Closes the claim, or names it lost when a STOP, a cancel or a later tick took it first. */
async function close(
  database: Database,
  row: GroupReminderRow,
  input: Parameters<typeof closeReminder>[2],
): Promise<FireOutcome> {
  return (await closeReminder(database, row, input)) ? input.status : 'lost';
}

/** Looked at once the text is written, just before it goes: a STOP or a cancel meanwhile wins. */
async function stillHeld(database: Database, row: GroupReminderRow): Promise<boolean> {
  if (await claimHeld(database, row)) return true;
  console.info(
    { reminderId: row.id, outcome: 'claim_lost' },
    'group reminders: taken back before the send, nothing sent',
  );
  return false;
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

async function lineAlreadyPosted(database: Database, dedupeKey: string): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, dedupeKey))
    .limit(1);
  return Boolean(row);
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
    recipientSeated: row.forPhoneHash ? recipientSeat !== null : null,
    audienceAllowed,
    askerCustomer,
    quietNow: await quietNowFor(database, row, seats, askerSeat, now),
    directReachable: reachable,
  });
  if (decision.kind === 'drop') {
    return close(database, row, { status: 'dropped', reason: decision.reason, now });
  }
  if (!row.what) return close(database, row, { status: 'failed', reason: 'no_what', now });
  const lineKey = `${GROUP_REMINDER_TEMPLATE}:${row.id}`;
  if (row.delivery === 'group' && (await lineAlreadyPosted(database, lineKey))) {
    return close(database, row, { status: 'sent', reason: 'already_sent', now });
  }

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
    // fireDecision already dropped a 1:1 with no asker as unreachable; this narrows the type.
    if (!row.askedByUserId) {
      return close(database, row, { status: 'dropped', reason: 'direct_unreachable', now });
    }
    if (!(await stillHeld(database, row))) return 'lost';
    const dedupeKey = `group-reminder:${row.id}`;
    await ports.enqueue({
      templateKey: MEMBER_REMINDER_TEMPLATE_KEY,
      familyId: row.familyId,
      parentUserId: row.askedByUserId,
      category: 'reminder',
      urgency: 'normal',
      payload: { text },
      dedupeKey,
      channel: 'sms',
    });
    await closeReminder(database, row, {
      status: 'queued',
      reason: null,
      now,
      after: { handedTo: 'channel_dispatch', dedupeKey },
    });
    return 'queued';
  }

  const ledgerUserId = (await primaryParentId(database, row.familyId)) ?? row.askedByUserId;
  if (!ledgerUserId) {
    return close(database, row, { status: 'failed', reason: 'no_ledger_owner', now });
  }
  if (!(await stillHeld(database, row))) return 'lost';
  const posted = await postGroupReminderLine(database, {
    familyId: row.familyId,
    ledgerUserId,
    chatId: row.chatId,
    text,
    replyTo: row.sourceMessageId,
    templateKey: GROUP_REMINDER_TEMPLATE,
    dedupeKey: lineKey,
    now,
    send: ports.send,
  });
  if (posted.outcome === 'not_sent') {
    if (posted.retryable) {
      console.warn(
        { reminderId: row.id, code: posted.code, outcome: 'retrying' },
        'group reminders: Linq refused for now, left claimed for a later tick',
      );
      return 'retrying';
    }
    return close(database, row, { status: 'failed', reason: posted.code, now });
  }
  await closeReminder(database, row, {
    status: 'sent',
    reason: posted.outcome === 'already_sent' ? 'already_sent' : null,
    now,
  });
  if (posted.outcome === 'sent') {
    const conversationId = await resolveOrCreateNoteConversation(
      row.familyId,
      channelGroupNoteKey(row.chatId),
      database,
    );
    await appendMessage(conversationId, 'assistant', text, database);
  }
  return 'sent';
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
    queued: 0,
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

/** Production wiring: the shared voice, the Linq group send, and the channel.send queue. */
export function groupReminderTickPorts(now: Date): GroupReminderTickPorts {
  return {
    now,
    voice: sharedGroupReminderVoice(),
    enqueue: async (job) => {
      const queue = await getQueue();
      await queue.send(CHANNEL_SEND_QUEUE, job, { expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    },
  };
}
