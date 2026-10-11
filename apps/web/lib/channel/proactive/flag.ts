import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';

/**
 * VIL-226 · context-driven cadence. Default off, so today's caps and senders stay
 * exactly as they are until this is armed.
 *
 * `off` — numeric caps and the current send path.
 * `shadow` — candidates are queued and the decider's choice is logged; the old path
 *   still sends.
 * `live` — numeric caps are skipped, queued kinds wait for the decider, and the decider
 *   sends.
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

/**
 * The classes whose sweeps hand their sends to the decider. A numeric cap gives way to
 * the decider only for these: a class that still sends on its own keeps its counter in
 * live, or nothing would bound it at all.
 */
export const DECIDER_ROUTED_KINDS: ReadonlySet<ProactiveSendKind> = new Set(['nudge']);

export function capDefersToDecider(kind: ProactiveSendKind): boolean {
  return cadenceSkipsNumericCaps() && DECIDER_ROUTED_KINDS.has(kind);
}
