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

/** Prompt-cache reads bill at 0.1x the base input rate (Anthropic pricing). */
const CACHE_READ_RATE_MULTIPLIER = 0.1;

/**
 * Sums input + output token cost for one agent call. With prompt caching on
 * (cachedSystem in structured.ts), the SDK splits prompt tokens three ways:
 * fresh `input_tokens` at full rate, `cache_creation_input_tokens` at full rate
 * (a slight underestimate — cache writes bill ~1.25x), and
 * `cache_read_input_tokens` at the 0.1x read rate. Each is non-null only when
 * that tier actually applied.
 */
export function estimateCostUsd(model: string, usage: Anthropic.Usage): number {
  const rate = RATES[model];
  if (!rate) {
    throw new Error(`estimateCostUsd: no rate configured for model '${model}'`);
  }
  const fullRateInputTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const outputTokens = usage.output_tokens;
  return (
    (fullRateInputTokens * rate.inputPerMTok) / PER_MTOK +
    (cacheReadTokens * rate.inputPerMTok * CACHE_READ_RATE_MULTIPLIER) / PER_MTOK +
    (outputTokens * rate.outputPerMTok) / PER_MTOK
  );
}
