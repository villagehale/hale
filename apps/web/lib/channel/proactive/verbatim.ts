import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';

/**
 * VIL-612 · classes whose sweep already wrote the parent-facing sentence.
 *
 * The hourly writer exists for finds and asks that still need a voice (a nudge,
 * an evening check-in). These kinds queue the CTA itself. Rewriting it would
 * drop the offer, the booking ask, or the intro card the sweep grounded.
 *
 * Immediate kinds never reach the queue.
 */
export const VERBATIM_KINDS = [
  'village_intro',
  'followup',
  'plan_check_in',
  'activity_followup',
  'spot_open',
  'email_alert',
  'calendar_alert',
  'duty_ask',
  'co_parent_departed',
  'travel_brief',
] as const satisfies readonly ProactiveSendKind[];

export type VerbatimKind = (typeof VERBATIM_KINDS)[number];

export function isVerbatimKind(kind: ProactiveSendKind): kind is VerbatimKind {
  return (VERBATIM_KINDS as readonly ProactiveSendKind[]).includes(kind);
}
