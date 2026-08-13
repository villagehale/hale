import Anthropic from '@anthropic-ai/sdk';
import { SAFETY_REPLY, namesAnEmergency } from '~/lib/channel/off-domain/copy';

/**
 * The outage smoke alarm — the one deliberate exception to the always-LLM doctrine
 * (founder-approved 2026-08-12).
 *
 * Hale composes everything it says. A compose that fails recomposes or defers; there
 * are no preset bodies waiting to stand in, because a preset body is a sentence nobody
 * reviewed against the situation it lands in. This is the single exception: when the
 * model API is UNREACHABLE and a parent's text carries an unambiguous emergency token,
 * the fixed 811/911 line goes out rather than that text waiting on an outage.
 *
 * IT IS NOT A FALLBACK FOR THE LLM. It fires only when there is no LLM. A turn that
 * broke on a tool, ran out of steps, hit a bug, or was refused by a gate keeps the
 * honesty line it has always had, however alarming the words in it are — which is why
 * {@link modelIsUnreachable} is a POSITIVE list rather than "anything unrecognised".
 *
 * WHY IT HAS TO EXIST, which the doctrine alone does not show. The deterministic safety
 * lane already answers a symptom with this exact sentence (off-domain/lane.ts) — but its
 * screen FAILS OPEN by design (screen.ts openTheGate), so during a provider outage the
 * screen cannot classify, and "she's not breathing" falls through to a coach that is
 * also down. The outage disables the one path built for that message, and what the
 * parent receives instead is "Something went wrong on my end". Every minute the model is
 * up, this module is unreachable and the screened lane does the work.
 *
 * PRIVACY. Nothing here logs, stores or transmits the parent's words. It reads the body
 * to answer one boolean and passes on a constant (rule #1).
 */

/** Why the alarm did or did not ring. Four outcomes, none of them silence (rule #11). */
export type SmokeAlarmOutcome =
  /** The line went out with no model in the loop. */
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
 * The two error shapes that mean the request never reached a model, and nothing else.
 *
 * A POSITIVE list — the opposite calibration from `classifyProviderFailure` in
 * monitoring/provider-health.ts, deliberately. That one sorts everything unrecognised
 * into `transient` so an unknown fault can never cancel a whole send window, which is
 * right for it and exactly wrong here: the same default would make every unrecognised
 * bug ring a siren at a parent. So an error this cannot identify is NOT an outage.
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

/** Whether the error the router's catch received says the model API was unreachable —
 * looking through the wrappers the turn put around it on the way up. */
export function modelIsUnreachable(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (isTransportFailure(current)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
  if (!namesAnEmergency(input.body)) {
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
  await input.say(SAFETY_REPLY);
  await input.claim.recordFired({ familyId, parentUserId, channelMessageId });
  return 'fired';
}
