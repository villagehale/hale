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
