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

let cached: Anthropic | undefined;
let cachedVoice: Anthropic | undefined;
let cachedActivity: Anthropic | undefined;

export function pipelineClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cached ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
  return cached;
}

/** The client for {@link ACTIVITY_CLIENT_OPTIONS}, process-cached for the same reason
 * the others are. */
export function activityClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cachedActivity ??= new Anthropic({ apiKey, ...ACTIVITY_CLIENT_OPTIONS });
  return cachedActivity;
}

/** The client for the calls in {@link VOICE_CLIENT_OPTIONS} — process-cached like every
 * other hot path, because a fresh HTTPS pool per phone call spends the budget it exists
 * to protect on a handshake. */
export function voiceClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cachedVoice ??= new Anthropic({ apiKey, ...VOICE_CLIENT_OPTIONS });
  return cachedVoice;
}
