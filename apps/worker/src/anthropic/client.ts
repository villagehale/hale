import Anthropic from '@anthropic-ai/sdk';
import { type HaleStage, traceAnthropic } from '../analytics/llm-trace.js';
import { config } from '../config.js';

/**
 * Raw Anthropic SDK client.
 *
 * Replaces the former Mastra / Vercel-AI-SDK provider abstraction. We call
 * `messages.create` directly so the raw `tool_use` blocks stay visible — hard
 * rule #3 (Reviewer must COUNT the verification tools it actually invoked)
 * needs them, and Mastra's structuredOutput hid them.
 *
 * Model ids live in @hale/agent (the single source + task→model routing); we
 * re-export them here so existing worker importers keep their import path.
 */

export { HAIKU_MODEL, SONNET_MODEL, OPUS_MODEL } from '@hale/agent';

/** Under the web function wall. The SDK default is 600s plus two retries. */
export const ANTHROPIC_TIMEOUT_MS = 60_000;
export const ANTHROPIC_MAX_RETRIES = 1;

let client: Anthropic | undefined;

/**
 * The ONE worker Anthropic client, handed through `traceAnthropic`: privacy-mode
 * `$ai_generation` events once POSTHOG_PROJECT_API_KEY is set, the bare client until then.
 * `stage` labels a call site for the LLM dashboard; the raw client stays cached once.
 */
export function anthropicClient(stage?: HaleStage): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Configure it in your environment to enable agent calls.',
    );
  }
  client ??= new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: ANTHROPIC_MAX_RETRIES,
  });
  return traceAnthropic(client, stage ? { stage } : {});
}
