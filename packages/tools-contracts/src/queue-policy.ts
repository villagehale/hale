/**
 * THE QUEUE-POLICY INVARIANT (SMS reliability audit P0-3): a pg-boss queue created bare
 * rides the library's defaults — two retries zero seconds apart and no dead letter —
 * which is how a transient provider blip during a weekly-brief burst permanently killed
 * a composed `channel.send` message with no ledger row and no trace. The inbound turn
 * queue was cured of this class once (apps/web/lib/channel/config.ts
 * CHANNEL_MESSAGE_RECEIVED_RETRY + a consumed DLQ, after the same bug shape); this
 * module makes the cure structural instead of site-by-site vigilance.
 *
 * It lives here because the pg-boss queues ARE the async contract between apps/web and
 * apps/worker, alongside their payload schemas — and because both apps create queues, so
 * the one blessed module has to sit in a leaf package they both depend on.
 *
 * `createQueueWithPolicy` is the ONLY place `boss.createQueue` may be invoked; a guard
 * test (apps/web/lib/cron/queue-policy-guard.test.ts) fails the build on any bare call.
 * The spec type is the invariant: `retry` and `deadLetter` are required, so a queue
 * without them is unexpressible rather than merely discouraged. Every dead letter named
 * here must be CONSUMED by its app (rule #11 — an unread dead-letter queue is a silent
 * drop with extra steps).
 */

/** The re-drive arc a queue runs its jobs on. All three fields required: pg-boss's
 * defaults (2 retries, 0s apart, no backoff) burn every attempt inside the same
 * transient blip, which is the failure mode this invariant exists to kill. */
export interface QueueRetryPolicy {
  readonly retryLimit: number;
  /** Seconds before the first retry; with `retryBackoff` the nth retry lands uniformly
   * in [delay·2^(n-1), delay·2^n) seconds. */
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
}

/** What a queue must declare to exist at all. */
export interface QueuePolicySpec {
  /** Seconds an active job may run before pg-boss's timeout sweep fails it. */
  expireInSeconds?: number;
  /** pg-boss queue policy (e.g. 'singleton'); omitted = 'standard'. */
  policy?: string;
  retry: QueueRetryPolicy;
  /** Where a job that spends every retry lands. Required — and it must be consumed. */
  deadLetter: string;
}

/** The wire shape pg-boss's createQueue/updateQueue take (v10). */
export interface QueueCreateOptions {
  name: string;
  expireInSeconds?: number;
  policy?: string;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  deadLetter?: string;
}

/** The slice of pg-boss this module needs — structural, so the real PgBoss, the apps'
 * injected queue ports and test fakes all satisfy it without imports. */
export interface PolicyQueueCreator {
  createQueue(name: string, options?: QueueCreateOptions): Promise<void>;
  updateQueue(name: string, options?: QueueCreateOptions): Promise<void>;
}

/**
 * Create (and CONVERGE) one queue under an explicit policy.
 *
 * Three load-bearing steps, in order:
 *  1. The dead-letter queue first — pg-boss's `dead_letter` column is a foreign key
 *     onto `queue(name)`, so naming a queue that does not exist yet is a constraint
 *     violation on first use. The DLQ carries the same retry arc as its queue (its
 *     consumer can throw too — a DB blip while recording an abandonment must not lose
 *     the abandonment) and, deliberately, no dead letter of its own: the chain ends here.
 *  2. createQueue with the full options.
 *  3. updateQueue with the SAME options — `create_queue` ends in ON CONFLICT DO
 *     NOTHING, so on any environment where the queue already exists (production, for
 *     every queue this invariant retrofits) create alone would leave pg-boss's defaults
 *     in place forever. Update is a no-op when the row is absent, so the pair is
 *     correct from either starting state. (The landmine the inbound queue already
 *     stepped on once — channel/twilio/deps.ts.)
 *
 * Idempotent; run it on every producer/consumer boot rather than remembering deploys.
 */
export async function createQueueWithPolicy(
  boss: PolicyQueueCreator,
  name: string,
  spec: QueuePolicySpec,
): Promise<void> {
  const dlqOptions: QueueCreateOptions = { name: spec.deadLetter, ...spec.retry };
  await boss.createQueue(spec.deadLetter, dlqOptions);
  await boss.updateQueue(spec.deadLetter, dlqOptions);

  const options: QueueCreateOptions = {
    name,
    ...(spec.expireInSeconds !== undefined ? { expireInSeconds: spec.expireInSeconds } : {}),
    ...(spec.policy !== undefined ? { policy: spec.policy } : {}),
    ...spec.retry,
    deadLetter: spec.deadLetter,
  };
  await boss.createQueue(name, options);
  await boss.updateQueue(name, options);
}
