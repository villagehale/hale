import { anthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';

type AnthropicModel = ReturnType<typeof anthropic>;

/**
 * Model factories — one per pinned Claude version we use across the
 * agent pipeline. Each agent file picks the right model for its job.
 *
 * Mastra Agents accept these directly; Mastra runs through Vercel AI
 * SDK's provider abstraction under the hood, so we get tool-use loops,
 * structured output, telemetry without writing it ourselves.
 */

function ensureKey(): void {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Configure it in your environment to enable agent calls.',
    );
  }
}

export function haikuModel(): AnthropicModel {
  ensureKey();
  return anthropic('claude-haiku-4-5-20251001');
}

export function sonnetModel(): AnthropicModel {
  ensureKey();
  return anthropic('claude-sonnet-4-6');
}
