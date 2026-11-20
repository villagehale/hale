import { flagValue, isEnabled } from '@hale/flags';
import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';

/**
 * VIL-226 · context-driven cadence. Default off, so today's senders stay
 * exactly as they are until this is armed.
 *
 * `off` — the review reads no family and sends nothing. Sweeps that still send on
 *   their own clock keep doing so until `PROACTIVE_SENDS_PAUSED` is exactly `true`.
 * `shadow` — candidates are queued and the decider's choice is logged; the old path
 *   still sends.
 * `live` — queued kinds wait for the decider, and the decider sends. It arms only
 *   once every class in {@link PROACTIVE_ROUTING} is routed; a requested `live`
 *   while any class is `not_routed` runs as `shadow`, and the review's summary
 *   says so. No mode has a count.
 *
 * Strict equality, no trim: a trailing newline from `vercel env add` must not arm it.
 */

export const PROACTIVE_CADENCE_ENV = 'PROACTIVE_CADENCE';

export type ProactiveCadence = 'off' | 'shadow' | 'live';

/**
 * How each proactive class reaches a phone once `live` is armed.
 *
 * `decider` — its sweep hands the send to the family queue.
 * `immediate` — it sends on its own clock in every mode (brief §1: the registration
 *   ladder and instant spot openings).
 * `not_routed` — its sweep still sends on its own path. It has no count of its own.
 *   Any class here keeps `live` from arming, because live would leave it outside the
 *   decider and the line-health pause.
 *
 * Every kind must be listed, so a new class cannot reach live unclassified.
 */
export const PROACTIVE_ROUTING: Record<ProactiveSendKind, 'decider' | 'immediate' | 'not_routed'> =
  {
    nudge: 'decider',
    registration_sequence: 'immediate',
    village_intro: 'decider',
    followup: 'decider',
    plan_check_in: 'decider',
    activity_followup: 'decider',
    spot_open: 'decider',
    spot_open_instant: 'immediate',
    email_alert: 'decider',
    calendar_alert: 'decider',
    evening_check_in: 'decider',
    mid_activity_ask: 'decider',
    next_day_checkback: 'decider',
    registration_opening: 'decider',
    school_break_ask: 'decider',
    co_parent_departed: 'decider',
    travel_brief: 'decider',
    duty_ask: 'decider',
    // Event-driven, on their own clock: the grant and the execution, not the decider's batch.
    autonomy_armed: 'immediate',
    autonomy_acted: 'immediate',
  };

/** The classes whose sweeps still send on their own, in table order. */
export function unroutedKinds(): ProactiveSendKind[] {
  return (Object.keys(PROACTIVE_ROUTING) as ProactiveSendKind[]).filter(
    (kind) => PROACTIVE_ROUTING[kind] === 'not_routed',
  );
}

/** What the env asks for, before the routing check. */
export function requestedCadence(): ProactiveCadence {
  const value = flagValue('proactive-cadence');
  if (value === 'shadow' || value === 'live') return value;
  return 'off';
}

/** The mode every seam runs in. */
export function proactiveCadence(): ProactiveCadence {
  const requested = requestedCadence();
  if (requested === 'live' && unroutedKinds().length > 0) return 'shadow';
  return requested;
}

/**
 * VIL-701 · credit abort, per-run family cap, mid-run stop, and one #ops page per
 * review. Off unless the env is exactly `true` (no trim): a trailing newline stays off.
 */
export function proactiveReviewGuardsEnabled(): boolean {
  return isEnabled('proactive-review-guards');
}

/**
 * VIL-701 · per-family daily model-decision cap inside the hourly review. Off unless
 * the env is exactly `true`.
 */
export function familyDecisionCapEnabled(): boolean {
  return isEnabled('proactive-family-decision-cap');
}

/**
 * VIL-722 · the family-wide weekly budget on what the hourly decider sends. Off unless the
 * env is exactly `true`. On is not a cap by itself: the number is
 * `PROACTIVE_WEEKLY_CAP_SENDS` (weekly-cap.ts), and unset is no cap. Read per family, so
 * PostHog can target one household once the PostHog path is on.
 */
export function proactiveWeeklyCapEnabled(familyId?: string): boolean {
  return isEnabled('proactive-weekly-cap', familyId);
}

/**
 * VIL-705 · refuses every proactive kind, immediate ones included. Replies to an
 * inbound text do not read this. Off unless the env is exactly `true`.
 *
 * An exact env `true` pauses even when PostHog has the flag loaded as false.
 * A remote value may also pause. It cannot unpause an env that is exactly `true`.
 */
export function proactiveSendsPaused(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.PROACTIVE_SENDS_PAUSED === 'true') return true;
  return isEnabled('proactive-sends-paused', undefined, env);
}
