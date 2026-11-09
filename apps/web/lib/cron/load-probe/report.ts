/**
 * What a drain load probe run measured, and whether it meets the launch bar (VIL-314):
 * p95 inbound-to-reply under 60 s, no text left unanswered, no text answered twice.
 * Counts and durations only.
 *
 * Two latencies, because the probe owns only one of them. The ANSWER is arrival to the
 * end of the turn, and most of it is the turn's own model time, which the probe replays
 * from production rather than produces. The DRAIN DELAY is what is left once that time is
 * taken out: the wait for a run to claim the text plus the run's own start and database
 * work. That is the part a change to the drain can move, so it carries its own bar.
 */

export const REPLY_P95_TARGET_MS = 60_000;
/** The drain's share of a reply. A run claims, works and completes in well under this
 * when it is not waiting on anything; a breach is queueing or connection trouble. */
export const DRAIN_DELAY_P95_TARGET_MS = 5_000;

export interface ProbeTextRecord {
  arrivedAtMs: number;
  /** The replayed model time of this text's turn. */
  turnMs: number;
  /** When a drain run first claimed the job; absent when none ever did. */
  claimedAtMs?: number;
  /** When the turn first finished; absent when it never did. */
  answeredAtMs?: number;
  /** How many times a turn for this text finished. More than one is a double reply. */
  answers: number;
}

export interface ProbeCounters {
  /** Drain runs started (kicked and scheduled). */
  runs: number;
  /** Runs that died because the database refused a connection. */
  exhaustedRuns: number;
  /** Runs that died for any other reason. */
  failedRuns: number;
  /** Turns whose own database work was refused (the job fails and retries). */
  turnDbErrors: number;
  /** Redeliveries of a text already answered, which the turn ledger ends without a send:
   * a run that died after the answer but before its job was completed. */
  redrivenAfterAnswer: number;
  /** Webhook enqueues the database refused. Production re-drives these from the
   * queue-maintenance reconciler, up to ten minutes later; the probe counts them
   * unanswered. */
  enqueueFailures: number;
  /** Most client connections the probe's role held at once. */
  peakConnections: number;
}

export interface ProbeReport extends ProbeCounters {
  texts: number;
  answered: number;
  unanswered: number;
  doubleAnswered: number;
  queueWaitP95Ms: number | null;
  queueWaitMaxMs: number | null;
  drainDelayP50Ms: number | null;
  drainDelayP95Ms: number | null;
  drainDelayMaxMs: number | null;
  answerP50Ms: number | null;
  answerP95Ms: number | null;
  answerOver60s: number;
}

/** Nearest-rank percentile; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

function max(values: readonly number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

export function summarizeProbe(
  records: readonly ProbeTextRecord[],
  counters: ProbeCounters,
): ProbeReport {
  const waits = records.flatMap((r) =>
    r.claimedAtMs === undefined ? [] : [r.claimedAtMs - r.arrivedAtMs],
  );
  const answered = records.filter((r) => r.answeredAtMs !== undefined);
  const answers = answered.map((r) => (r.answeredAtMs as number) - r.arrivedAtMs);
  const delays = answered.map((r) => (r.answeredAtMs as number) - r.arrivedAtMs - r.turnMs);
  return {
    ...counters,
    texts: records.length,
    answered: answered.length,
    unanswered: records.length - answered.length,
    doubleAnswered: records.filter((r) => r.answers > 1).length,
    queueWaitP95Ms: percentile(waits, 95),
    queueWaitMaxMs: max(waits),
    drainDelayP50Ms: percentile(delays, 50),
    drainDelayP95Ms: percentile(delays, 95),
    drainDelayMaxMs: max(delays),
    answerP50Ms: percentile(answers, 50),
    answerP95Ms: percentile(answers, 95),
    answerOver60s: answers.filter((ms) => ms > REPLY_P95_TARGET_MS).length,
  };
}

export type ProbeMiss =
  | 'no_texts'
  | 'unanswered'
  | 'double_answered'
  | 'drain_delay_p95'
  | 'answer_p95';

export interface ProbeVerdict {
  /** The drain's own bar: every text answered once, and its share of the wait small. */
  drainPass: boolean;
  /** The ticket's bar on the whole answer, model time included. */
  answerPass: boolean;
  misses: ProbeMiss[];
}

export function judgeProbe(report: ProbeReport): ProbeVerdict {
  const misses: ProbeMiss[] = [];
  if (report.texts === 0) misses.push('no_texts');
  if (report.unanswered > 0) misses.push('unanswered');
  if (report.doubleAnswered > 0) misses.push('double_answered');
  if (report.drainDelayP95Ms === null || report.drainDelayP95Ms >= DRAIN_DELAY_P95_TARGET_MS) {
    misses.push('drain_delay_p95');
  }
  const drainPass = misses.length === 0;
  if (report.answerP95Ms === null || report.answerP95Ms >= REPLY_P95_TARGET_MS) {
    misses.push('answer_p95');
  }
  return { drainPass, answerPass: drainPass && !misses.includes('answer_p95'), misses };
}
