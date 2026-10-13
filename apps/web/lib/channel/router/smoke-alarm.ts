import Anthropic from '@anthropic-ai/sdk';
import { namesAMentalCrisis, namesAnEmergency } from '~/lib/channel/off-domain/copy';

/**
 * The outage smoke alarm.
 *
 * Hale composes everything it says, including a crisis or emergency reply
 * (moment-reply.ts). There is no preset body to stand in when the model is
 * unreachable. This module still notices that the text is an emergency or a crisis
 * during that outage, and names the miss (`unwritten`) so the turn defers instead of
 * sending a canned line or falling through to the honesty template. When the model is
 * back, the screened lane writes the reply.
 *
 * IT IS NOT A FALLBACK FOR THE LLM. It runs only when there is no LLM. A turn that
 * broke on a tool, ran out of steps, hit a bug, or was refused by a gate keeps the
 * honesty line it has always had — which is why {@link modelIsUnreachable} is a
 * POSITIVE list rather than "anything unrecognised".
 *
 * PRIVACY. Nothing here logs, stores or transmits the parent's words. It reads the body
 * to answer one boolean (rule #1).
 */

/** Why the alarm did or did not ring. None of them is silence (rule #11). */
export type SmokeAlarmOutcome =
  /** Kept for a claim recorded before preset bodies were removed. Nothing is sent. */
  | 'already_fired'
  /** The model is down and the text is an emergency or a crisis. Nothing preset goes out. */
  | 'unwritten'
  /** The turn broke, but the provider was reachable — an ordinary failed turn. */
  | 'not_an_outage'
  /** An outage, and nothing in the text is an unambiguous emergency. */
  | 'no_emergency_token';

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
  /** Sends and records exactly like any other reply: transport, delivery ledger, audit
   * row (rule #6), and the parent's thread. The alarm gets no private send path. */
  say(body: string): Promise<void>;
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
  const { familyId, channelMessageId } = input;
  if (await input.claim.alreadyFired({ familyId, channelMessageId })) {
    return 'already_fired';
  }

  // The model writes this reply, and the model is unreachable. Nothing preset goes out,
  // and the claim is not recorded, so a later attempt can still write it.
  console.error(
    { outcome: 'unwritten' },
    'smoke alarm: emergency during an outage; moment reply unwritten',
  );
  return 'unwritten';
}
