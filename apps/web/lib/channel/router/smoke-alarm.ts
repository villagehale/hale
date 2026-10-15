import Anthropic from '@anthropic-ai/sdk';
import { namesAMentalCrisis, namesAnEmergency } from '~/lib/channel/off-domain/copy';
import { logCrisisUnanswered } from '~/lib/channel/voice/said-line';

/**
 * The outage smoke alarm.
 *
 * When the model API is UNREACHABLE and a parent's text carries an unambiguous
 * emergency or crisis token, there is no model to write a reply and, since #868
 * (Barton, 2026-10-14), no fixed crisis line to send instead — the "Call 911 now."
 * exception is gone. What remains is the alarm itself: an urgent, body-free log so
 * #ops reaches the parent, claimed once per inbound.
 *
 * It fires only when there is no LLM ({@link modelIsUnreachable} is a POSITIVE list).
 *
 * PRIVACY. Nothing here logs, stores or transmits the parent's words (rule #1).
 */

/** Why the alarm did or did not ring. Four outcomes, none of them silence (rule #11). */
export type SmokeAlarmOutcome =
  /** An outage met a crisis token: nothing went out (no line is fixed, #868), the
   * urgent #ops log fired, and the inbound is claimed so a re-drive pages once. */
  | 'fired'
  /** The turn broke, but the provider was reachable — an ordinary failed turn. */
  | 'not_an_outage'
  /** An outage, and nothing in the text is an unambiguous emergency. */
  | 'no_emergency_token'
  /** This same inbound already rang it: a queue re-drive, not a second emergency. */
  | 'already_fired';

/**
 * The alarm's memory — one row per text that rang it.
 *
 * Injected rather than queried inline because the drain is at-least-once BY DESIGN
 * (lib/cron/drain.ts): a crash anywhere after the send hands the same job back and the
 * turn re-runs from the top. Without the claim, one outage plus a retry loop is a parent
 * in an emergency receiving the same two phone numbers over and over.
 *
 * Keyed on the INBOUND message id — the thing that can arrive twice. The outbound reply
 * is a new row every time and would dedupe nothing.
 */
export interface SmokeAlarmClaim {
  alreadyFired(input: { familyId: string; channelMessageId: string }): Promise<boolean>;
  recordFired(input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
  }): Promise<void>;
}

/** How far down a `cause` chain to look. The coach wraps once (channel/coach/runtime.ts
 * rethrows the provider error inside a ChannelTurnFailed); the rest is slack for a
 * future wrapper, and the bound is what makes a cyclic `cause` terminate. */
const MAX_CAUSE_DEPTH = 5;

/**
 * What kind of failure a turn was — the ONE question the router's catch asks, and the
 * only classification of a failed turn anywhere in the channel.
 *
 * `defect` is the honest name for everything the positive list below does not
 * recognise: our own request shape rejected, a tool that threw, a zod crash, a dead
 * query, a plain bug. The model API was REACHABLE for every one of them, and that is
 * what the router acts on — it is the difference between a turn worth re-running later
 * and a turn worth apologising for now, in Hale's own words, because there is a model up
 * to write them.
 */
export type TurnFailure = 'model_unreachable' | 'defect';

/**
 * The two error shapes that mean the request never reached a model, and nothing else.
 *
 * A POSITIVE list — the opposite calibration from `classifyProviderFailure` in
 * monitoring/provider-health.ts, deliberately. That one sorts everything unrecognised
 * into `transient` so an unknown fault can never cancel a whole send window, which is
 * right for it and exactly wrong here: the same default would make every unrecognised
 * bug ring a siren at a parent — and, since the defer arc, hold a parent's text in a
 * retry queue for two hours over a bug that will fail identically every time. So an
 * error this cannot identify is NOT an outage.
 *
 * 429 is absent for the same reason: a rate limit is our own burst, not the provider
 * being gone. Both shapes below are thrown only after the SDK has spent its own retries.
 */
function isTransportFailure(err: unknown): boolean {
  // Covers APIConnectionTimeoutError, which is a subclass.
  if (err instanceof Anthropic.APIConnectionError) {
    return true;
  }
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 500;
}

/**
 * Read a failed turn — looking through the wrappers it put around the real error on the
 * way up (the coach rethrows the provider error inside a `ChannelTurnFailed`).
 */
export function classifyTurnFailure(err: unknown): TurnFailure {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined;
    depth += 1
  ) {
    if (isTransportFailure(current)) {
      return 'model_unreachable';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return 'defect';
}

/** The alarm's own reading, in the boolean it branches on. Derived rather than
 * re-implemented: the siren and the router's three-way must never be able to disagree
 * about whether the provider was there. */
export function modelIsUnreachable(err: unknown): boolean {
  return classifyTurnFailure(err) === 'model_unreachable';
}

export interface SmokeAlarmInput {
  claim: SmokeAlarmClaim;
  /** The error the router's catch already received — classified, never re-thrown. */
  err: unknown;
  body: string;
  familyId: string;
  parentUserId: string;
  channelMessageId: string;
}

/**
 * Both conditions, or nothing.
 *
 * ORDER. The two cheap pure checks run first and the claim read last, so the query is
 * spent only in the rare case where the line is actually about to go out — the
 * overwhelmingly common failed turn is a healthy provider and an ordinary week.
 */
export async function considerSmokeAlarm(input: SmokeAlarmInput): Promise<SmokeAlarmOutcome> {
  if (!modelIsUnreachable(input.err)) {
    return 'not_an_outage';
  }
  if (!namesAnEmergency(input.body) && !namesAMentalCrisis(input.body)) {
    return 'no_emergency_token';
  }
  const { familyId, parentUserId, channelMessageId } = input;
  if (await input.claim.alreadyFired({ familyId, channelMessageId })) {
    return 'already_fired';
  }

  // SEND, THEN CLAIM — the router's own ordering rule (route.ts sendReply), for the same
  // reason turned up one notch. A claim written first would turn a send that failed into
  // a text the parent never gets at all: the re-drive would read the claim and stay
  // quiet about an emergency nobody answered.
  // #868 (Barton, 2026-10-14): the fixed "Call 911 now." outage line is gone; there is
  // no fixed crisis line anywhere. With no model to write one, nothing is sent and #ops
  // is paged urgently, once per inbound (the claim still dedupes the re-drive).
  logCrisisUnanswered(namesAnEmergency(input.body) ? 'emergency' : 'mental', 'model_outage');
  await input.claim.recordFired({ familyId, parentUserId, channelMessageId });
  return 'fired';
}
