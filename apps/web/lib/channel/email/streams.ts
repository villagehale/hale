import type { EmailType } from '~/lib/cron/email-compliance';

/**
 * Every stream a typed "unsubscribe" covers. Listed explicitly rather than derived, so
 * adding a stream is a decision about whether an unsubscribe should reach it.
 *
 * It lives in its own module because two sides of the same fact read it: the inbound
 * STOP keyword WRITES this set (inbound.ts), and the reply path READS it to decide
 * whether a parent has stopped email altogether (sendable.ts). One list, so the question
 * "did they say stop" cannot be answered differently by the two halves.
 */
export const UNSUBSCRIBABLE_STREAMS = [
  'daily_digest',
  'weekly_plan',
  'reminder',
  'approval',
  'alert',
] as const satisfies readonly EmailType[];
