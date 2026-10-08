/**
 * VIL-226 · context-driven cadence. Default off, so today's caps and senders
 * stay exactly as they are until this is armed.
 *
 * `off` — numeric caps and the current send path.
 * `shadow` — enqueue and log what the decider would send; the old path still sends.
 * `live` — numeric caps are skipped, senders enqueue, and the decider sends.
 *
 * Strict equality, no trim: a trailing newline from `vercel env add` must not arm it.
 */

export const PROACTIVE_CADENCE_ENV = 'PROACTIVE_CADENCE';

export type ProactiveCadence = 'off' | 'shadow' | 'live';

export function proactiveCadence(): ProactiveCadence {
  const value = process.env[PROACTIVE_CADENCE_ENV];
  if (value === 'shadow' || value === 'live') return value;
  return 'off';
}

/** Live is the only mode that stops a send. Shadow records and still sends. */
export function cadenceSkipsNumericCaps(): boolean {
  return proactiveCadence() === 'live';
}
