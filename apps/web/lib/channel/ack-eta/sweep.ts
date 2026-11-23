import type { AckPromiseOutcome, Database } from '@hale/db';
import type { ProactiveHoldReason, ProactiveSendVerdict } from '~/lib/channel/outbound-gate';
import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import {
  linqRefusedForCertain,
  readSendRefusal,
  refusalStopsRetry,
  sendResolvingNewChat,
} from '~/lib/channel/outbound-transport';
import type { LineHold } from '~/lib/channel/proactive/review';
import type { AckComposeFallback, AckLineWriter, LateNoteFacts } from './compose';
import {
  type AckReplyState,
  type DueAckPromise,
  ackReplyState,
  ackSendWasAttempted,
  claimAckPromise,
  familyErasureScheduled,
  holdAckPromise,
  loadDueAckPromises,
  recordLateNote,
  releaseAckClaim,
  settleAckPromise,
} from './promise';
import { lateWindowMinutes, retryCeilingMs } from './window';

/**
 * VIL-717 · THE DEADLINE SWEEP — the one note when Hale is later than it said.
 *
 * Runs as a leg of the scheduled every-minute drain. It reads the promises whose stated
 * window has passed (promise.ts), works out what each one needs, CLAIMS it (so a note fires
 * at most once per text, however many ticks overlap), and settles it with a named outcome:
 *
 *   answered     the reply landed; nothing was owed and nothing is sent.
 *   lane_off     ACK_ETA_ENABLED or F14 is off for the family now; nothing is sent.
 *   stale        the tick reached it long after it could first have gone; a note then
 *                would only confuse, so nothing is sent.
 *   held         the outbound gate refused it for good (no live channel, no watch consent),
 *                before the write or at the send, or the family asked to be erased; nothing
 *                is sent.
 *   unwritten    the model could not write a sendable note; nothing is sent, #ops paged.
 *   send_failed  Linq refused it for certain; nothing landed, #ops paged.
 *   sent         the note went to the parent's number now: under the ask while that chat is
 *                still their 1:1 on this line, otherwise in their current 1:1.
 *
 * A SEND THAT DID NOT CONFIRM IS NOT AN ENDING. A rate limit, a 5xx, a timeout or any
 * refusal that cannot prove the text stayed home gives the claim back, and the next tick
 * tries again inside the stale window under the same Linq key, which Linq will not deliver
 * twice. So does a read that throws after the claim, because nothing was sent. An owed
 * note that is finally dropped pages #ops.
 *
 * The note is written from facts only (compose.ts). While the text is still being retried
 * it says Hale is still on it and how much longer it will keep trying: the queue's retry
 * ceiling, counted from the ask (window.ts). That is a limit on trying, not a time the
 * answer will come, because past the ceiling a turn is never answered (channel/config.ts).
 * When the turn ended with no answer, or the ceiling has passed, it says nothing more is
 * coming on it. The reply is read once more right before the send, so a reply that lands
 * while the note is being written stops it.
 *
 * THE OUTBOUND GATE DECIDES. This is a cron's message, not the direct reply the quiet floor
 * exempts (outbound-gate.ts `inProactiveQuietHours`), so it is a proactive class of its own
 * (`ack_late_note`) and reaches the transport only on an `allowed` verdict, read before the
 * claim and again on the send's own clock. A hold that can lift leaves the row unclaimed:
 * the parent's night until the first tick after the floor opens, as a recovered first reply
 * does (intake/first-reply-recovery.ts), and the operator pause or an unread opt-out until
 * they clear or the note goes stale. Caught on the send's clock, after the claim, the same
 * holds give the claim back. A refusal that will not lift settles it, named.
 *
 * THE LINE-HEALTH PAUSE HOLDS IT TOO. Routed `immediate`, the note is outside the decider
 * that honours the pause, so it reads the same hold itself (proactive/review.ts
 * `readLineHold`), before the claim and again before the send.
 */

/** The named ending for a family inside its erasure grace window. */
const ERASURE_SCHEDULED = 'erasure_scheduled';

/** How many due promises one tick takes. The rest are a minute later. */
export const ACK_SWEEP_BATCH = 5;

/**
 * A note is worth sending only this long after it could first have gone: the end of the
 * window it reports on, or the end of the night it was held through.
 */
export const ACK_LATE_NOTE_STALE_MS = 20 * 60 * 1000;

/**
 * The sweep's share of the drain tick. It runs before the queues, inside the roughly 100s
 * the drain's wall budget leaves under the function ceiling, and an outage is exactly when
 * promises come due with a model that only times out. Past this it starts no more notes;
 * the rest stay unclaimed for the next minute.
 */
export const ACK_SWEEP_BUDGET_MS = 20_000;

/**
 * Room for a note between the quiet-hours check and its send: up to two drafts and their
 * judge calls on a 12s client (compose.ts). A note that could land after the floor closes
 * waits for morning instead.
 */
export const ACK_NOTE_WRITE_HEADROOM_MS = 3 * 60_000;

/** What #ops is told about a late note that will not reach the parent. */
export type LateNotePage = {
  stage: 'late_note';
  reason:
    | AckComposeFallback
    | 'send_refused'
    | 'send_unconfirmed'
    | 'line_held'
    | 'note_dropped'
    | 'claim_stuck';
};

export interface AckDeadlinePorts {
  /** ACK_ETA_ENABLED, for this family, now. */
  enabled(familyId: string): boolean;
  /** F14's dark-launch gate: whether Hale may start a conversation with this family at all. */
  f14For(familyId: string): boolean;
  /** Wall-clock milliseconds, for {@link ACK_SWEEP_BUDGET_MS} and the send's own clock. */
  clock(): number;
  writer: AckLineWriter;
  /** The outbound chokepoint's verdict on one late note to this parent at `now`. */
  gate(request: {
    familyId: string;
    parentUserId: string;
    now: Date;
  }): Promise<ProactiveSendVerdict>;
  /** When the quiet floor opens for this parent, or null when it is open now. */
  quietUntil(parentUserId: string, now: Date): Promise<Date | null>;
  /** Why Hale's sending line carries no unrequested send right now, or null when it can. */
  lineHold(): Promise<LineHold | null>;
  /** The parent's sendable number, read now and never stored on the promise. Null when
   * they have no live, verified channel (a stop revokes it), which holds the note. */
  phone(parentUserId: string): Promise<string | null>;
  /** The phone door: it threads into the ask's chat only while that is still this number's 1:1. */
  transport: ChannelTransport;
  /** Pages #ops once per hour per site (failure-page.ts `pageOps`). Never throws. */
  page(page: LateNotePage): Promise<unknown>;
  /** Puts the sent note in the parent's thread, so the coach can read their answer to it. */
  thread(input: { familyId: string; parentUserId: string; body: string }): Promise<unknown>;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface AckDeadlineSweepSummary {
  due: number;
  claimed: number;
  /** Due promises left for the next tick: its budget ran out, or a read before the claim failed. */
  deferred: number;
  /** Due promises that owe a note and were left unclaimed: it is night on the parent's clock. */
  quietHeld: number;
  /** Due promises left unclaimed behind a hold that can lift: a pause or an unread opt-out. */
  railHeld: number;
  /** Claims given back this tick: the send did not confirm, or a read threw. Still owed. */
  released: number;
  settled: Partial<Record<AckPromiseOutcome, number>>;
}

interface Settlement {
  outcome: AckPromiseOutcome;
  reason?: string;
  noteChannelMessageId?: string | null;
  /** Set when this ending drops a note the parent was owed. */
  page?: LateNotePage['reason'];
}

/** Nothing was settled: the claim goes back and the note stays owed. */
interface Release {
  release: string;
  sendAttempted: boolean;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Under the ask when there is one to thread under. The door decides whether that chat is
 * still this parent's: a number that moved gets the note in its own 1:1 instead. */
function noteThread(promise: DueAckPromise): Pick<OutboundMessage, 'replyIn'> {
  if (promise.channel !== 'imessage' || !promise.providerChatId || !promise.replyToMessageId) {
    return {};
  }
  return {
    replyIn: {
      chatId: promise.providerChatId,
      messageId: promise.replyToMessageId,
      plainResendOnlyIfRefused: true,
    },
  };
}

/** Past saying: longer than {@link ACK_LATE_NOTE_STALE_MS} after it could first have gone. */
function isStale(promise: DueAckPromise, now: Date): boolean {
  const firstCouldGo = Math.max(promise.dueAt.getTime(), promise.heldUntil?.getTime() ?? 0);
  return now.getTime() - firstCouldGo > ACK_LATE_NOTE_STALE_MS;
}

/** What one due promise needs, read before anyone claims it. */
type NotePlan =
  /** Nothing goes, for a reason with a name: claim it and settle. */
  | { kind: 'settle'; settlement: Settlement }
  /** A note is owed and the gate allows it: claim it, write it, send it. */
  | { kind: 'write'; state: Exclude<AckReplyState, 'answered'> }
  /** A note is owed and it is night on the parent's clock: unclaimed until the floor opens. */
  | { kind: 'night'; until: Date }
  /** A hold that can lift inside the stale window: left unclaimed for the next tick. */
  | { kind: 'rail'; reason: ProactiveHoldReason | LineHold };

/** How a note that went past saying ends, and whether the parent was still owed it. */
async function staleEnding(
  database: Database,
  ports: AckDeadlinePorts,
  promise: DueAckPromise,
): Promise<Settlement> {
  if ((await ackReplyState(database, promise)) === 'answered') return { outcome: 'stale' };
  const hold = await ports.lineHold();
  if (hold) return { outcome: 'stale', reason: hold, page: 'line_held' };
  if (await ackSendWasAttempted(database, promise)) {
    return { outcome: 'stale', reason: 'send_unconfirmed', page: 'send_unconfirmed' };
  }
  return { outcome: 'stale', page: 'note_dropped' };
}

async function planNote(
  database: Database,
  ports: AckDeadlinePorts,
  promise: DueAckPromise,
  now: Date,
): Promise<NotePlan> {
  const settle = (settlement: Settlement): NotePlan => ({ kind: 'settle', settlement });
  if (!ports.enabled(promise.familyId)) return settle({ outcome: 'lane_off' });
  if (!ports.f14For(promise.familyId)) return settle({ outcome: 'lane_off', reason: 'f14_dark' });
  if (await familyErasureScheduled(database, promise.familyId)) {
    return settle({ outcome: 'held', reason: ERASURE_SCHEDULED });
  }
  if (isStale(promise, now)) return settle(await staleEnding(database, ports, promise));
  const state = await ackReplyState(database, promise);
  if (state === 'answered') return settle({ outcome: 'answered' });

  const lineHold = await ports.lineHold();
  if (lineHold) return { kind: 'rail', reason: lineHold };

  const { familyId, parentUserId } = promise;
  const verdict = await ports.gate({ familyId, parentUserId, now });
  if (verdict.allowed) {
    const closing = await ports.quietUntil(
      parentUserId,
      new Date(now.getTime() + ACK_NOTE_WRITE_HEADROOM_MS),
    );
    return closing ? { kind: 'night', until: closing } : { kind: 'write', state };
  }
  switch (verdict.reason) {
    case 'quiet_hours': {
      const until = await ports.quietUntil(parentUserId, now);
      return until ? { kind: 'night', until } : { kind: 'rail', reason: verdict.reason };
    }
    case 'sends_paused':
    case 'opt_out_unread':
      return { kind: 'rail', reason: verdict.reason };
    case 'not_enrolled':
    case 'no_watch_consent':
      return settle({ outcome: 'held', reason: verdict.reason });
  }
}

/**
 * Writes and sends one claimed note. It throws only before the send, so a caller that
 * catches a throw knows nothing went.
 */
async function writeNote(
  database: Database,
  ports: AckDeadlinePorts,
  promise: DueAckPromise,
  state: Exclude<AckReplyState, 'answered'>,
  now: Date,
  sendClock: () => Date,
): Promise<Settlement | Release> {
  const phone = await ports.phone(promise.parentUserId);
  if (!phone) return { outcome: 'held', reason: 'not_enrolled' };

  // Past the ceiling the job has dead-lettered, so an open row is not being worked on.
  const stillTrying =
    state === 'open' && now.getTime() < promise.askedAt.getTime() + retryCeilingMs();
  const facts: LateNoteFacts = {
    task: promise.task,
    promisedMinutes: promise.promisedMinutes,
    minutesSinceAsk: Math.max(0, Math.floor((now.getTime() - promise.askedAt.getTime()) / 60_000)),
    status: stillTrying ? 'still_working' : 'stopped',
    newWithinMinutes: stillTrying ? lateWindowMinutes(promise.askedAt, now) : null,
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
  if (await familyErasureScheduled(database, promise.familyId)) {
    return { outcome: 'held', reason: ERASURE_SCHEDULED };
  }
  const lineHold = await ports.lineHold();
  if (lineHold) return { release: lineHold, sendAttempted: false };
  // So may a stop. The gate again, on the clock the send will actually go out on.
  const atSend = await ports.gate({
    familyId: promise.familyId,
    parentUserId: promise.parentUserId,
    now: sendClock(),
  });
  if (!atSend.allowed) {
    switch (atSend.reason) {
      case 'quiet_hours':
      case 'sends_paused':
      case 'opt_out_unread':
        return { release: atSend.reason, sendAttempted: false };
      case 'not_enrolled':
      case 'no_watch_consent':
        return { outcome: 'held', reason: atSend.reason };
    }
  }

  let sent: Awaited<ReturnType<ChannelTransport['send']>>;
  try {
    sent = await sendResolvingNewChat(ports.transport, {
      to: phone,
      ...noteThread(promise),
      body: composed.line,
      // Linq drops a resend under the same key, so a retry of a send that landed is no
      // second text, and every attempt for this promise is the same send.
      sendKey: `ack_eta_late_note:${promise.id}`,
    });
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'threw';
    const certain = linqRefusedForCertain(err);
    ports.log.warn(
      { promiseId: promise.id, err: errName(err), code, certain },
      'ack eta: the late note did not go',
    );
    if (certain && refusalStopsRetry(err)) {
      return { outcome: 'send_failed', reason: code, page: 'send_refused' };
    }
    return { release: code, sendAttempted: !certain };
  }

  let noteChannelMessageId: string | null = null;
  try {
    noteChannelMessageId = await recordLateNote(database, {
      promise,
      sent: {
        providerMessageId: sent.providerMessageId,
        channel: sent.transport === 'imessage' ? 'imessage' : 'sms',
        chatId: sent.chatId ?? null,
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
    quietHeld: 0,
    railHeld: 0,
    released: 0,
    settled: {},
  };
  const startedMs = ports.clock();
  const sendClock = () => new Date(now.getTime() + (ports.clock() - startedMs));
  for (const [index, promise] of due.entries()) {
    if (ports.clock() - startedMs >= ACK_SWEEP_BUDGET_MS) {
      summary.deferred += due.length - index;
      break;
    }
    let plan: NotePlan;
    try {
      plan = await planNote(database, ports, promise, now);
      if (plan.kind === 'night') await holdAckPromise(database, promise.id, plan.until);
    } catch (err) {
      // Nothing is claimed and nothing went, so the next tick asks again.
      ports.log.error(
        { promiseId: promise.id, err: errName(err) },
        'ack eta: the read before the claim threw, nothing sent',
      );
      summary.deferred += 1;
      continue;
    }
    if (plan.kind === 'night') {
      summary.quietHeld += 1;
      continue;
    }
    if (plan.kind === 'rail') {
      summary.railHeld += 1;
      ports.log.info(
        { promiseId: promise.id, reason: plan.reason },
        'ack eta: a send rail holds the note for now',
      );
      continue;
    }
    if (!(await claimAckPromise(database, promise.id, now))) continue;
    summary.claimed += 1;
    let result: Settlement | Release;
    try {
      result =
        plan.kind === 'settle'
          ? plan.settlement
          : await writeNote(database, ports, promise, plan.state, now, sendClock);
    } catch (err) {
      ports.log.error(
        { promiseId: promise.id, err: errName(err) },
        'ack eta: the deadline check threw, nothing sent',
      );
      result = { release: 'check_failed', sendAttempted: false };
    }
    if ('release' in result) {
      summary.released += 1;
      try {
        await releaseAckClaim(database, {
          promise,
          claimedAt: now,
          reason: result.release,
          sendAttempted: result.sendAttempted,
        });
      } catch (err) {
        ports.log.error(
          { promiseId: promise.id, err: errName(err) },
          'ack eta: the claim could not be given back, this note is lost',
        );
        await ports.page({ stage: 'late_note', reason: 'claim_stuck' });
      }
      continue;
    }
    const settlement = result;
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
    if (settlement.page) await ports.page({ stage: 'late_note', reason: settlement.page });
  }
  return summary;
}
