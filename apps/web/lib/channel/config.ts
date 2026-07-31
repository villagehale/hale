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
