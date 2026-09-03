import type { LoopCategory } from './types';

/**
 * Per-category send caps the dispatch enforces (constants here, never inline — the
 * ticket's rule). Each is a rolling window: at most `max` non-suppressed sends of
 * that category to a parent within `windowHours`. A weekly plan is once a week; a
 * reminder at most twice a day. Approvals/alerts are looser but still bounded so a
 * misfiring caller can't flood a parent.
 */
export const CATEGORY_CAPS: Record<LoopCategory, { max: number; windowHours: number }> = {
  weekly_plan: { max: 1, windowHours: 24 * 7 },
  reminder: { max: 2, windowHours: 24 },
  approval: { max: 10, windowHours: 24 },
  alert: { max: 5, windowHours: 24 },
};

/** The pg-boss queue the durable channel.send jobs ride (drained by lib/cron/drain). */
export const CHANNEL_SEND_QUEUE = 'channel.send';

/**
 * VIL-214 · A3 — the inbound counterpart: one job per text from a parent whose family
 * is already past intake, for C1 to answer. Deliberately NOT `events.ingested`: that
 * queue carries SIGNALS to be classified, and a conversation turn is neither a signal
 * nor classify-worthy — routing it there would run a parent's reply through the wrong
 * pipeline (scout decision on VIL-214).
 *
 * A3 only PRODUCES. The consumer lands with C1; until then the durable record is the
 * channel_messages row the producer writes, and an undrained job simply expires.
 */
export const CHANNEL_MESSAGE_RECEIVED_QUEUE = 'channel.message.received';

/**
 * VIL-220 · C1 — the queue POLICY, which is what makes the singleton key mean anything.
 *
 * pg-boss enforces a singleton key only where the policy says to (its unique index is
 * declared `WHERE policy = …`), and 'singleton' is the one policy that means "one job
 * per key active at a time, the rest wait their turn" — 'short' and 'stately' REJECT
 * the extra jobs instead, which would drop a parent's second text. Together with a
 * per-conversation key that is per-conversation FIFO.
 *
 * It lives here beside the queue name, in the module with no runtime imports, because
 * the producer (channel/twilio/deps) and the consumer (cron/drain) both need it and
 * neither should reach through the other to get it. cron/drain is imported for its
 * expiry constant by every route that approves an action, and channel/twilio/deps pulls
 * a db handle and a queue client — an import edge between them would put both on that
 * path for the sake of one string.
 */
export const CHANNEL_MESSAGE_RECEIVED_POLICY = 'singleton';

/**
 * THE DEFER CEILING — how long Hale will hold a parent's text waiting for a model.
 *
 * The router throws a turn back when the provider is unreachable (router/route.ts
 * TurnDeferred), so the retry policy is no longer queue plumbing: it IS the product
 * decision about how late an answer may be before it stops being worth sending.
 *
 * pg-boss's backoff (its failJobs plan) schedules the nth retry uniformly in
 * `[delay·2^(n-1), delay·2^n)` seconds. With 15s and 8 retries that is roughly:
 *
 *   15-30s · 30-60s · 1-2m · 2-4m · 4-8m · 8-16m · 16-32m · 32-64m
 *
 * — a total window of about one to two hours, with the first four attempts inside the
 * first ten minutes, which is where the overwhelming majority of provider outages end.
 * The drain runs every minute, so the backoff and not the cron is what sets the pace.
 *
 * PAST THE CEILING THE PARENT IS NEVER ANSWERED, and that is the founder's chosen
 * trade rather than an oversight: an apology arriving two hours after a question is
 * worse than silence, because it is a notification that tells them nothing and asks them
 * to remember what they wanted. The job dead-letters instead of vanishing, so the
 * abandoned turn is a row you can count (see {@link CHANNEL_MESSAGE_RECEIVED_DLQ}).
 *
 * These sit on the QUEUE rather than on each send, which is how the policy converges on
 * an environment where the queue already exists — see channel/twilio/deps.ts, where
 * createQueue + updateQueue are run as a pair for exactly that reason.
 */
export const CHANNEL_MESSAGE_RECEIVED_RETRY = {
  retryLimit: 8,
  retryDelay: 15,
  retryBackoff: true,
} as const;

/**
 * Where a turn goes when the ceiling is reached — pg-boss's own dead-letter queue, so
 * the ceiling is a NAMED outcome rather than a job that quietly stops existing (rule
 * #11). The drain consumes it, logs `turn_expired_unanswered`, and sends nothing.
 *
 * It covers every terminal path, not just the one the drain watches: a job that expires
 * mid-flight because the function died is failed by pg-boss's own timeout sweep, which
 * runs through the same plan and lands in the same place.
 */
export const CHANNEL_MESSAGE_RECEIVED_DLQ = 'channel.message.received.dead';

/** The log outcome for a turn that ran out of retries. A DATA value: it is what
 * telemetry counts, so it is never renamed with the code. */
export const TURN_EXPIRED_UNANSWERED = 'turn_expired_unanswered';

/**
 * SMS reliability audit P0-3 — the OUTBOUND ceiling, cut from the same cloth as
 * {@link CHANNEL_MESSAGE_RECEIVED_RETRY}. `channel.send` used to ride pg-boss's
 * defaults (two retries zero seconds apart, no dead letter), so a transient Twilio
 * blip during a weekly-brief burst burned all three attempts inside the same blip and
 * the composed message stopped existing with no ledger row and no trace.
 *
 * Same arc as the inbound cure — 15s doubling to ~an hour, first attempts inside the
 * first minutes where provider blips overwhelmingly end — but the trade past the
 * ceiling is the opposite one: a weekly brief or a reminder arriving an hour late is
 * still worth having (nobody is holding a phone waiting on it), so the arc leans on
 * the later, longer waits rather than giving up early. Past the ceiling the job
 * dead-letters into {@link CHANNEL_SEND_DLQ}, whose drain consumer writes a terminal
 * `failed` channel_messages row — a countable outcome, never a log-only grave.
 */
export const CHANNEL_SEND_RETRY = {
  retryLimit: 8,
  retryDelay: 15,
  retryBackoff: true,
} as const;

/** Where a channel.send job that spent every retry lands. Consumed by lib/cron/drain,
 * which records the abandonment on the ledger (dispatch.ts recordAbandonedDispatch). */
export const CHANNEL_SEND_DLQ = 'channel.send.dead';

/** The ledger `error_code` for a send that ran out of retries. A DATA value: it is
 * what the founder digest and telemetry count, so it is never renamed with the code. */
export const SEND_RETRIES_EXHAUSTED = 'send_retries_exhausted';
