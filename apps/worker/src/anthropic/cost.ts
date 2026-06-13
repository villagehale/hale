import type Anthropic from '@anthropic-ai/sdk';
import { HAIKU_MODEL, SONNET_MODEL } from './client.js';

/**
 * Per-model token rates, USD per million tokens.
 * Source: Anthropic pricing (claude-api skill model table, cached 2026-06-04):
 * Sonnet 4.6 $3 in / $15 out per 1M; Haiku 4.5 $1 in / $5 out per 1M.
 * Hardcoded by design — billing accuracy is a point-in-time estimate, not a
 * live lookup; rotate these constants when public pricing changes.
 */
interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

const RATES: Record<string, ModelRate> = {
  [SONNET_MODEL]: { inputPerMTok: 3, outputPerMTok: 15 },
  [HAIKU_MODEL]: { inputPerMTok: 1, outputPerMTok: 5 },
};

const PER_MTOK = 1_000_000;

/**
 * Sums input + output token cost for one agent call. Cache-read and
 * cache-creation tokens are folded into `input_tokens` exposure here as plain
 * input cost — the worker does not yet use prompt caching, so the SDK reports
 * them as null. Accumulates raw input_tokens at full rate.
 */
export function estimateCostUsd(model: string, usage: Anthropic.Usage): number {
  const rate = RATES[model];
  if (!rate) {
    throw new Error(`estimateCostUsd: no rate configured for model '${model}'`);
  }
  const inputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens;
  return (
    (inputTokens * rate.inputPerMTok) / PER_MTOK +
    (outputTokens * rate.outputPerMTok) / PER_MTOK
  );
}
