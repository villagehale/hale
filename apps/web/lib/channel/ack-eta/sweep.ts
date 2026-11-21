import type { AckPromiseOutcome, Database } from '@hale/db';
import { LinqSendError } from '~/lib/channel/linq/transport';
import type { ReplyRoute, ReplyTransport } from '~/lib/channel/router/reply-route';
import type { AckComposeFallback, AckLineWriter, LateNoteFacts } from './compose';
import {
  type DueAckPromise,
  ackReplyState,
  claimAckPromise,
  loadDueAckPromises,
  pruneSettledAckPromises,
  recordLateNote,
  settleAckPromise,
} from './promise';
import { lateWindowMinutes } from './window';

/**
 * VIL-717 · THE DEADLINE SWEEP — the one note when Hale is later than it said.
 *
 * Runs as a leg of the scheduled every-minute drain. It reads the promises whose stated
 * window has passed (promise.ts), CLAIMS each one before anything else (so a note fires at
 * most once per text, however many ticks overlap), and settles it with a named outcome:
 *
 *   answered     the reply landed; nothing was owed and nothing is sent.
 *   lane_off     ACK_ETA_ENABLED is off for the family now; nothing is sent.
 *   stale        the tick reached it long after it came due; a note then would only
 *                confuse, so nothing is sent.
 *   held         a send rail stopped it: sends paused, no live channel, or an unread
 *                opt-out; nothing is sent.
 *   unwritten    the model could not write a sendable note; nothing is sent, #ops paged.
 *   send_failed  the transport refused it.
 *   sent         the note went, in the ask's own 1:1 (threaded under it on iMessage).
 *
 * The note is written from facts only (compose.ts). While the text is still being retried
 * it says Hale is still on it and gives the new honest window: the queue's retry ceiling,
 * counted from the ask (window.ts). When the turn ended with no answer it says nothing more
 * is coming on it. The reply is read once more right before the send, so a reply that lands
 * while the note is being written stops it.
 *
 * REPLY-CLASS, NOT PROACTIVE. The note follows a text the parent sent minutes earlier, in
 * the thread they opened, so it is not held for quiet hours. What bounds it instead is the
 * staleness window below: past it, nothing is sent at all.
 */

/** How many due promises one tick takes. The rest are a minute later. */
export const ACK_SWEEP_BATCH = 5;

/** A note is worth sending only this long after the window it reports on closed. */
export const ACK_LATE_NOTE_STALE_MS = 20 * 60 * 1000;

/**
 * The sweep's share of the drain tick. It runs before the queues, inside the roughly 100s
 * the drain's wall budget leaves under the function ceiling, and an outage is exactly when
 * promises come due with a model that only times out. Past this it starts no more notes;
 * the rest stay unclaimed for the next minute.
 */
export const ACK_SWEEP_BUDGET_MS = 20_000;

/** Why a send rail held a note. A closed vocabulary: it lands in an audit row. */
export type AckSendRail = 'clear' | 'sends_paused' | 'opt_out_unread';

export interface AckDeadlinePorts {
  /** ACK_ETA_ENABLED, for this family, now. */
  enabled(familyId: string): boolean;
  /** Wall-clock milliseconds, for {@link ACK_SWEEP_BUDGET_MS}. */
  clock(): number;
  writer: AckLineWriter;
  /** The rails a note passes before it is written. */
  rail(parentUserId: string): Promise<AckSendRail>;
  /** The parent's sendable number, read now and never stored on the promise. Null when
   * they have no live, verified channel (a stop revokes it), which holds the note. */
  phone(parentUserId: string): Promise<string | null>;
  transport: ReplyTransport;
  /** Pages #ops once per hour per site (failure-page.ts `pageOps`). Never throws. */
  page(page: { stage: 'late_note'; reason: AckComposeFallback }): Promise<unknown>;
  /** Puts the sent note in the parent's thread, so the coach can read their answer to it. */
  thread(input: { familyId: string; parentUserId: string; body: string }): Promise<unknown>;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface AckDeadlineSweepSummary {
  due: number;
  claimed: number;
  /** Due promises left unclaimed for the next tick because this one spent its budget. */
  deferred: number;
  settled: Partial<Record<AckPromiseOutcome, number>>;
  pruned: number;
}

interface Settlement {
  outcome: AckPromiseOutcome;
  reason?: string;
  noteChannelMessageId?: string | null;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** The route the ask came in on, rebuilt for the note: its own 1:1 chat, under the ask. */
function noteRoute(promise: DueAckPromise, phone: string): ReplyRoute {
  if (promise.channel === 'imessage' && promise.providerChatId) {
    return {
      channel: 'imessage',
      to: phone,
      chatId: promise.providerChatId,
      replyToMessageId: promise.replyToMessageId,
    };
  }
  return { channel: 'sms', to: phone };
}

/** What became of one claimed promise. Never throws for a reason it can name. */
async function settleOne(
  database: Database,
  ports: AckDeadlinePorts,
  promise: DueAckPromise,
  now: Date,
): Promise<Settlement> {
  if (!ports.enabled(promise.familyId)) return { outcome: 'lane_off' };
  if (now.getTime() - promise.dueAt.getTime() > ACK_LATE_NOTE_STALE_MS) return { outcome: 'stale' };

  const state = await ackReplyState(database, promise);
  if (state === 'answered') return { outcome: 'answered' };

  const rail = await ports.rail(promise.parentUserId);
  if (rail !== 'clear') return { outcome: 'held', reason: rail };
  const phone = await ports.phone(promise.parentUserId);
  if (!phone) return { outcome: 'held', reason: 'not_enrolled' };

  const facts: LateNoteFacts = {
    task: promise.task,
    promisedMinutes: promise.promisedMinutes,
    minutesSinceAsk: Math.max(0, Math.floor((now.getTime() - promise.askedAt.getTime()) / 60_000)),
    status: state === 'open' ? 'still_working' : 'stopped',
    newWithinMinutes: state === 'open' ? lateWindowMinutes(promise.askedAt, now) : null,
    language: promise.language,
  };
  const composed = await ports.writer.lateNote(facts);
  if (composed.status !== 'composed') {
    await ports.page({ stage: 'late_note', reason: composed.reason });
    return { outcome: 'unwritten', reason: composed.reason };
  }
  // The reply may have landed while the note was being written. Read once more, last.
  if ((await ackReplyState(database, promise)) === 'answered') {
    return { outcome: 'answered', reason: 'while_writing' };
  }

  let sent: Awaited<ReturnType<ReplyTransport['send']>>;
  try {
    sent = await ports.transport.send({
      route: noteRoute(promise, phone),
      body: composed.line,
      // Linq drops a resend under the same key: one note per promise at the provider too.
      sendKey: `ack_eta_late_note:${promise.id}`,
    });
  } catch (err) {
    ports.log.warn(
      { promiseId: promise.id, err: errName(err) },
      'ack eta: the late note did not go',
    );
    return { outcome: 'send_failed', reason: err instanceof LinqSendError ? err.code : 'threw' };
  }

  let noteChannelMessageId: string | null = null;
  try {
    noteChannelMessageId = await recordLateNote(database, {
      promise,
      sent: {
        providerMessageId: sent.providerMessageId,
        channel: sent.channel,
        chatId: sent.chatId ?? (promise.channel === 'imessage' ? promise.providerChatId : null),
      },
      now,
    });
  } catch (err) {
    ports.log.error(
      { promiseId: promise.id, err: errName(err) },
      'ack eta: the late note went, its ledger row did not land',
    );
  }
  try {
    await ports.thread({
      familyId: promise.familyId,
      parentUserId: promise.parentUserId,
      body: composed.line,
    });
  } catch (err) {
    ports.log.error(
      { promiseId: promise.id, err: errName(err) },
      'ack eta: the late note went, it is not in the thread',
    );
  }
  return { outcome: 'sent', noteChannelMessageId };
}

/** One tick of the deadline sweep. */
export async function runAckDeadlineSweep(
  database: Database,
  ports: AckDeadlinePorts,
  now: Date,
): Promise<AckDeadlineSweepSummary> {
  const due = await loadDueAckPromises(database, now, ACK_SWEEP_BATCH);
  const summary: AckDeadlineSweepSummary = {
    due: due.length,
    claimed: 0,
    deferred: 0,
    settled: {},
    pruned: 0,
  };
  const startedMs = ports.clock();
  for (const [index, promise] of due.entries()) {
    if (ports.clock() - startedMs >= ACK_SWEEP_BUDGET_MS) {
      summary.deferred = due.length - index;
      break;
    }
    if (!(await claimAckPromise(database, promise.id, now))) continue;
    summary.claimed += 1;
    let settlement: Settlement;
    try {
      settlement = await settleOne(database, ports, promise, now);
    } catch (err) {
      // A read that threw before anything was sent: nothing went, and the claim stands, so
      // no later tick can send a note the parent might get twice.
      ports.log.error(
        { promiseId: promise.id, err: errName(err) },
        'ack eta: the deadline check threw, nothing sent',
      );
      settlement = { outcome: 'held', reason: 'check_failed' };
    }
    await settleAckPromise(database, {
      promise,
      outcome: settlement.outcome,
      ...(settlement.reason ? { reason: settlement.reason } : {}),
      noteChannelMessageId: settlement.noteChannelMessageId ?? null,
      now,
    });
    summary.settled[settlement.outcome] = (summary.settled[settlement.outcome] ?? 0) + 1;
    ports.log.info(
      {
        promiseId: promise.id,
        outcome: settlement.outcome,
        ...(settlement.reason ? { reason: settlement.reason } : {}),
      },
      'ack eta: deadline settled',
    );
  }
  summary.pruned = await pruneSettledAckPromises(database, now);
  return summary;
}
