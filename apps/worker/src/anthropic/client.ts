import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * Raw Anthropic SDK client + pinned model ids.
 *
 * Replaces the former Mastra / Vercel-AI-SDK provider abstraction. We call
 * `messages.create` directly so the raw `tool_use` blocks stay visible — hard
 * rule #3 (Reviewer must COUNT the verification tools it actually invoked)
 * needs them, and Mastra's structuredOutput hid them.
 */

export const HAIKU_MODEL = 'claude-haiku-4-5';
export const SONNET_MODEL = 'claude-sonnet-4-6';

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
