import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';

/**
 * The shared Anthropic client for the inbound pipeline (classify/draft/review).
 * Mirrors the cron + coach factories: a single cached instance, and a hard throw
 * if the key is missing rather than a silent no-op. Injected into ingestEvent so
 * tests pass a fake (rule #8 — no LLM mocking for quality; the fake exercises the
 * loop mechanics only).
 */
let cached: Anthropic | undefined;

export function pipelineClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  cached ??= new Anthropic({ apiKey });
  return cached;
}
