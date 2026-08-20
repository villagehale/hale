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

let cached: Anthropic | undefined;
let cachedVoice: Anthropic | undefined;

export function pipelineClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cached ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
  return cached;
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
