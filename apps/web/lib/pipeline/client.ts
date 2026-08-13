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

let cached: Anthropic | undefined;

export function pipelineClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cached ??= new Anthropic({ apiKey, ...HOT_SMS_CLIENT_OPTIONS });
  return cached;
}
