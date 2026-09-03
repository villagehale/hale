import {
  type DeepResearchPayload,
  type QueueCreateOptions,
  createQueueWithPolicy,
} from '@hale/tools-contracts';
import type { ActivityPromiseRecordOutcome } from './commitment';
import { owesDepth } from './evidence';

/**
 * THE QUEUE THE QUESTION-TIME DEEP PASS RIDES.
 *
 * WHY IT IS NOT ONE OF THE HOT QUEUES. Every other queue in this system carries a job
 * measured in seconds: a text to route, an action to execute, a rank to materialise.
 * This one carries three concurrent research legs and an `xhigh` merge.
 *
 * MEASURED LIVE, 2026-08-24, production wiring, against the real web, on a real municipal
 * subject (the Gellert fall swim schedule — a page with a thirty-row grid on it):
 *
 *   legs        38.7s, 66.9s and 97.4s, concurrent — 97.4s of wall clock
 *   synthesis   89.5s (Opus, 64,046 in / 11,314 out)
 *   JOB TOTAL   189.4s, and $1.81 — $1.75 of tokens plus six web searches at $0.01
 *
 * THREE RUNS OF THAT SAME SUBJECT LANDED AT 189.4s, 198.8s AND 167.2s, so the spread is
 * real but narrow and the number to size against is two hundred seconds rather than the
 * luckiest one. The whole question-to-two-messages turn, including the inline lane that
 * answers the parent immediately, measured $2.80 and 8 searches.
 *
 * THOSE NUMBERS REPLACED AN EARLIER 63.3s / $1.3646, AND THE GAP IS THE SUBJECT. The first
 * measurement ran against a venue with a short programme page. A municipality publishing
 * its whole fall grid is the case this lane was BUILT for, and it is three times the wall
 * clock: the merge has thirty-odd dated rows to reconcile and now emits a verbatim quote
 * beside every fact, which is most of the 11,314 output tokens. Both halves of that are
 * load-bearing, so 190 seconds is the number to size against and 63 was the easy case.
 *
 * Three minutes is well inside the hot expiry, and nowhere near it by the margin an
 * outlier needs: a municipal PDF that takes two minutes to fetch is an ordinary bad day,
 * and a job that runs past 180s is expired by pg-boss's own timeout sweep WHILE STILL
 * RUNNING and redelivered — so a parent gets the same expensive answer twice and the bill
 * three times. Its expiry is its own number.
 */

/** The queue name. A DATA value: it is a row in pg-boss's `queue` table and a string in
 * the drain plan, so it is never renamed with the code. */
export const DEEP_RESEARCH_QUEUE = 'deep.research';

/**
 * How long a deep job may run before pg-boss reclaims it.
 *
 * FIFTEEN MINUTES, against a measured run of 190 seconds. The margin is deliberate and it
 * is not slack: the failure mode of a too-small expiry is INVISIBLE and expensive — the
 * job keeps running to completion, sends its text, and is redelivered anyway because the
 * sweep already took it back. A generous expiry costs nothing, because the drain's own
 * wall-clock budget is what actually bounds the run; this number only decides when a job
 * that has genuinely died is allowed to be tried again.
 */
export const DEEP_RESEARCH_EXPIRE_SECONDS = 900;

/**
 * ONE JOB AT A TIME, and this is the reason the drain needed a per-queue batch size.
 *
 * `drainQueue` re-checks its deadline between BATCHES, never between jobs, so a batch of
 * ten deep jobs would run for the better part of an hour inside a function with a
 * 800-second ceiling — killed mid-flight, every job expired and redelivered, the whole
 * corpus researched twice. At one per fetch the deadline is honoured between every job
 * and the drain's every-minute cadence is what sets throughput.
 */
export const DEEP_RESEARCH_BATCH_SIZE = 1;

/**
 * How far into a drain run a deep job may still be STARTED.
 *
 * The step's slice is measured from the start of the run (drain.ts), and this queue is
 * drained LAST — so the number answers one question: if we begin a deep job now, does it
 * finish inside the run's own 700-second budget?
 *
 * FIVE MINUTES, DOWN FROM SEVEN, because the measured run went from 63 seconds to ~190 (see
 * the module note: a real municipal grid, not a short venue page, measured three times at
 * 167-199s). Seven minutes plus 190s lands at 610s — still inside the 700s budget, but with
 * nothing left for a job any slower than the average one, which is precisely the job this
 * bound exists to protect against. At five minutes a run TWICE the slowest measured one
 * finishes at 698s and still lands inside it.
 * Past the bound the tick hands the job back and the next cron minute picks it up, so the
 * cost of being early is a minute and the cost of being late is a killed job, a promise
 * redelivered, and the whole corpus researched twice.
 *
 * IT IS ALSO WHY THERE IS NO CHUNKED-STAGE MACHINERY HERE. A leg that risked the ceiling
 * would have to checkpoint its state in Postgres between stages; at 190 seconds against a
 * 700-second budget that would be a durable state machine bought for nothing.
 */
export const DEEP_RESEARCH_BUDGET_MS = 300_000;

/**
 * The retry arc (queue-policy invariant, audit P0-3 — no queue rides pg-boss defaults).
 * TWO retries, kept at pg-boss's own count on purpose: a deep job is minutes of wall
 * clock and dollars of tokens, so more attempts multiply spend, and a promise the queue
 * abandons is still OPEN on the ledger for the hourly sweep — the system this queue
 * accelerated works without it. Sixty seconds' backoff, because a retry seconds after an
 * infrastructure fault lands on the same fault.
 */
export const DEEP_RESEARCH_RETRY = {
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/** Where a deep job that spent every retry lands. Consumed by lib/cron/drain (a named
 * log outcome — the promise itself stays open for the hourly sweep, so nothing is owed
 * a ledger write here). */
export const DEEP_RESEARCH_DLQ = 'deep.research.dead';

/**
 * ONE JOB PER PROMISE, FOREVER — and it is the job ID that guarantees it, not the key.
 *
 * pg-boss's insert ends in `ON CONFLICT DO NOTHING`, so a second send under the same id
 * creates nothing, and the id here is the COMMITMENT id: an identity that already exists,
 * is already a uuid, and is already the only pointer the payload carries. A promise that
 * is superseded gets a new row and therefore a new id, which is exactly right — the new
 * promise is a new question and deserves its own research.
 *
 * The singleton KEY is the same string and does a different job: it serialises, so a
 * retry that overlaps a still-running attempt waits rather than doubling the spend. The
 * two together mean a promise can be researched once, retried safely, and never twice at
 * the same time.
 */
export function deepResearchJobOptions(payload: DeepResearchPayload): {
  id: string;
  singletonKey: string;
  expireInSeconds: number;
} {
  return {
    id: payload.commitment_id,
    singletonKey: payload.commitment_id,
    expireInSeconds: DEEP_RESEARCH_EXPIRE_SECONDS,
  };
}

/** The minimal pg-boss surface the producer uses, injected so the id, the key and the
 * expiry are assertable without a live queue (the `MessageQueue` pattern). */
export interface DeepResearchQueue {
  createQueue(name: string, options?: QueueCreateOptions): Promise<void>;
  updateQueue(name: string, options?: QueueCreateOptions): Promise<void>;
  send(
    name: string,
    data: DeepResearchPayload,
    options?: { id?: string; singletonKey?: string; expireInSeconds?: number },
  ): Promise<string | null>;
}

/**
 * WHAT BECAME OF THE DISPATCH — named, because a promise that was going to be answered in
 * two minutes and is now going to be answered in twenty-four hours is a real difference
 * nobody would otherwise see (rule #11).
 *
 * `already_queued` is a SUCCESS in every sense that matters: the job exists, the promise
 * will be kept. It is counted apart from a fresh enqueue only so a re-drive storm is
 * legible as one.
 */
export type DeepDispatchOutcome =
  | { status: 'enqueued' }
  | { status: 'already_queued' }
  | { status: 'not_enqueued'; reason: 'no_depth_owed' | 'not_recorded' | 'queue_unavailable' };

/**
 * Enqueue the deep pass for a promise that was just written down.
 *
 * IT NEVER THROWS, and that is the contract with the router. This runs after the parent's
 * reply has already been sent and the promise is already a row; an exception here would
 * buy a carrier retry and a duplicate text, and would trade a fast answer for a lost one.
 * The promise stays open either way, so the worst a failed dispatch costs is that the
 * hourly sweep keeps it instead — which is the system working as it did before this queue
 * existed.
 */
export async function dispatchDeepResearch(
  /** A RESOLVER, so a queue that cannot be opened at all is the same counted outcome as
   * one that refuses the send — the connection is where this fails in practice. */
  resolve: () => Promise<DeepResearchQueue>,
  payload: DeepResearchPayload,
): Promise<DeepDispatchOutcome> {
  try {
    const queue = await resolve();
    await createQueueWithPolicy(queue, DEEP_RESEARCH_QUEUE, {
      expireInSeconds: DEEP_RESEARCH_EXPIRE_SECONDS,
      retry: DEEP_RESEARCH_RETRY,
      deadLetter: DEEP_RESEARCH_DLQ,
    });
    const created = await queue.send(
      DEEP_RESEARCH_QUEUE,
      payload,
      deepResearchJobOptions(payload),
    );
    return created ? { status: 'enqueued' } : { status: 'already_queued' };
  } catch (err) {
    // Ids and a class, never the payload — and the sentence says what the parent loses,
    // which is speed and not the answer.
    console.error(
      {
        commitmentId: payload.commitment_id,
        err: err instanceof Error ? err.message : 'unknown',
      },
      'activity deep dispatch: could not enqueue - the promise stays open for the hourly sweep',
    );
    return { status: 'not_enqueued', reason: 'queue_unavailable' };
  }
}

/**
 * THE DECISION, in one place: does this promise get answered in minutes or in a day?
 *
 * It is a function rather than four lines in the router because all four of its answers
 * are outcomes somebody has to be able to count (rule #11), and three of them are
 * indistinguishable from the outside:
 *
 *   NOT RECORDED — the promise itself did not become a row. Nothing to research, and the
 *   ledger writer has already logged the bigger problem.
 *   NO DEPTH OWED — the subject names no place and asks for nothing on a timetable, so
 *   there is no page worth opening today. The hourly sweep still keeps the promise.
 *   QUEUE UNAVAILABLE — the enqueue failed. Same answer for the parent as the line above,
 *   arrived at for a completely different reason, and a dashboard that folded them
 *   together could not tell a broken queue from a quiet week.
 *
 * NOTHING HERE CHANGES WHETHER THE PROMISE IS KEPT. Every branch leaves the ledger row
 * exactly as the router wrote it — open, due within the day, selected by the hourly sweep.
 * The only thing at stake is how fast.
 */
export async function dispatchDepthForPromise(
  dispatch: (payload: DeepResearchPayload) => Promise<DeepDispatchOutcome>,
  input: {
    familyId: string;
    /** The de-identified subject, off the promise the coach's tool registered. */
    subject: string;
    recorded: ActivityPromiseRecordOutcome;
  },
): Promise<DeepDispatchOutcome> {
  if (input.recorded.status !== 'recorded') {
    return { status: 'not_enqueued', reason: 'not_recorded' };
  }
  if (!owesDepth(input.subject)) {
    return { status: 'not_enqueued', reason: 'no_depth_owed' };
  }
  return dispatch({
    commitment_id: input.recorded.commitmentId,
    family_id: input.familyId,
  });
}
