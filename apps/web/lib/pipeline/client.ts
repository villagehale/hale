import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';

/**
 * The shared Anthropic client for the inbound pipeline (classify/draft/review).
 * Mirrors the cron + coach factories: a single cached instance, and a hard throw
 * if the key is missing rather than a silent no-op. Injected into ingestEvent so
 * tests pass a fake (rule #8 — no LLM mocking for quality; the fake exercises the
 * loop mechanics only).
 */
/**
 * Options for every client on the SMS hot path — a parent is holding a phone.
 * One request gets 30s and one retry; past that the turn defers into the queue's
 * own backoff (#434), where a late real reply beats a blocked drain. Measured
 * 2026-08-13: a single coach call rode SDK-internal retries to 90s and held the
 * drain for all of it.
 */
export const HOT_SMS_CLIENT_OPTIONS = { timeout: 30_000, maxRetries: 1 } as const;

/**
 * Options for a model call A CALLER IS WAITING ON IN SILENCE — the spoken turn's own
 * stream, and the reply resolver that runs before it.
 *
 * SHORTER than the SMS budget, not longer, and that is the whole point. The 30s + one
 * retry above is affordable because a timed-out text defers into pg-boss and a late reply
 * still lands; a phone call has nowhere to defer to, so the same budget buys sixty seconds
 * of dead air and then a fixed apology delivered to a caller who hung up forty seconds
 * ago (the v2 incident: call opened 03:48:34, "turn failed" logged 03:49:45). Eight
 * seconds is roughly five times the measured time-to-first-token for a spoken turn, and
 * about as long as anyone holds a silent line.
 *
 * No retry, for the same reason: a retry is a second helping of the same silence.
 *
 * This bounds TIME-TO-HEADERS, not the answer. The SDK clears its abort timer when the
 * response headers arrive (`fetchWithTimeout`'s `.finally()`), so a long spoken answer is
 * never cut off by it — only a stalled or grammar-compiling request is.
 */
export const VOICE_CLIENT_OPTIONS = { timeout: 8_000, maxRetries: 0 } as const;

/**
 * Options for the activity lane's WEB-GROUNDED call — the one model request on the SMS
 * path that goes out to the open web before it answers.
 *
 * It is not a coach turn and the SMS budget above was never sized for it. A grounding
 * call runs several live searches server-side and measured 16s, 21s and 23s on the runs
 * that worked; a 30s ceiling sits inside that spread, so the calls that needed 35s were
 * killed rather than slow. Then `maxRetries: 1` bought a second 30s of the same, and the
 * lane's OWN retry (activity/lane.ts) bought two more: four attempts, none of which was
 * ever given enough time, and 132s of a parent holding a phone for a reply that said the
 * search hit a snag.
 *
 * So: one attempt, long enough to actually finish. The SDK retry is REMOVED rather than
 * shortened because the lane already retries and already logs the attempt — two invisible
 * tries underneath one visible one is how the wall clock quadrupled without anyone
 * choosing it.
 */
export const ACTIVITY_CLIENT_OPTIONS = { timeout: 50_000, maxRetries: 0 } as const;

/**
 * Options for the activity lane's grounding call WHEN A CALLER IS ON THE LINE.
 *
 * The wall that bounds the caller's silence is six seconds and it lives in the tool
 * (twilio/voice-lookup.ts), not here — a race cannot cancel an HTTP request. So this is
 * the bill: once the wall closes, nobody is waiting on the search any more, and the fifty
 * seconds above would keep a research turn running and billing for another forty-four for
 * an answer no caller will ever hear. Ten is the wall plus enough slack that a search
 * which was ALMOST in time still finishes and warms the provider's fetch cache for the
 * sweep that pays the promise an hour later.
 */
export const VOICE_LOOKUP_CLIENT_OPTIONS = { timeout: 10_000, maxRetries: 0 } as const;

/**
 * Options for a model call inside a CRON-HOSTED SWEEP or drained batch job — the
 * weekly registration-verify, discovery, inference, week-plan, rank/curate, the
 * followup and intros composers. Nobody is holding a phone, but the hosting
 * function's wall is real: every cron route here runs at maxDuration 300 (drain
 * at 800 with its own 700s budget), while the SDK's silent defaults are 600s +
 * 2 retries — one stalled call may legally outlive the whole window (2026-09-03
 * audit P1-7: registration-verify claims its week BEFORE working, so that stall
 * burned the claim and the sweep silently skipped to next Monday). 60s bounds
 * one request; with one retry the worst case is ~2min, inside 300s with room
 * for the rest of the sweep and the finally-flush.
 */
export const CRON_SWEEP_CLIENT_OPTIONS = { timeout: 60_000, maxRetries: 1 } as const;

/** Every client budget: time-to-headers bound (ms) + SDK retry count, both
 * mandatory — the whole point is that neither can silently ride an SDK default. */
export interface AnthropicBudget {
  timeout: number;
  maxRetries: number;
}

/**
 * The ONE place `new Anthropic` may be written in apps/web — enforced by
 * no-raw-anthropic.test.ts (audit P1-7). Constructing here forces every client
 * to state its budget explicitly, because the SDK's silent defaults (600s,
 * 2 retries) are bigger than every serverless window this app runs in. Throws
 * on a missing key (rule #8 — a silent no-op client is not a client); callers
 * that legitimately run keyless check the env themselves first.
 */
export function budgetedAnthropic(budget: AnthropicBudget): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  return new Anthropic({ apiKey, ...budget });
}

let cached: Anthropic | undefined;
let cachedVoice: Anthropic | undefined;
let cachedVoiceLookup: Anthropic | undefined;
let cachedActivity: Anthropic | undefined;

export function pipelineClient(): AgentClient {
  cached ??= budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
  return cached;
}

/** The client for {@link ACTIVITY_CLIENT_OPTIONS}, process-cached for the same reason
 * the others are. */
export function activityClient(): AgentClient {
  cachedActivity ??= budgetedAnthropic(ACTIVITY_CLIENT_OPTIONS);
  return cachedActivity;
}

/** The client for {@link VOICE_LOOKUP_CLIENT_OPTIONS} — the activity lane, reached from a
 * phone call. Its own instance rather than `activityClient()`'s because the two differ
 * only in the one thing that matters here, how long an abandoned search may keep
 * spending. */
export function voiceLookupClient(): AgentClient {
  cachedVoiceLookup ??= budgetedAnthropic(VOICE_LOOKUP_CLIENT_OPTIONS);
  return cachedVoiceLookup;
}

/** The client for the calls in {@link VOICE_CLIENT_OPTIONS} — process-cached like every
 * other hot path, because a fresh HTTPS pool per phone call spends the budget it exists
 * to protect on a handshake. */
export function voiceClient(): AgentClient {
  cachedVoice ??= budgetedAnthropic(VOICE_CLIENT_OPTIONS);
  return cachedVoice;
}
