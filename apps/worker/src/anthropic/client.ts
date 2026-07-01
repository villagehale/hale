import Anthropic from '@anthropic-ai/sdk';
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

export { HAIKU_MODEL, SONNET_MODEL, SONNET5_MODEL, OPUS_MODEL } from '@hale/agent';

let client: Anthropic | undefined;

export function anthropicClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Configure it in your environment to enable agent calls.',
    );
  }
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return client;
}
