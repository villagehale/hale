import type Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd as priceTokenTiers } from '@hale/agent';

/**
 * Costs one raw-SDK call by handing its usage to the shared pricing table in
 * `@hale/agent` (rates + cache multipliers live there so the web process, which
 * cannot import worker src, prices the identical way). With prompt caching on
 * (cachedSystem in structured.ts), the SDK splits prompt tokens three ways:
 * fresh `input_tokens` at the full rate, `cache_creation_input_tokens` at 1.25x,
 * and `cache_read_input_tokens` at 0.1x. Each is non-null only when that tier
 * actually applied.
 */
export function estimateCostUsd(model: string, usage: Anthropic.Usage): number {
  return priceTokenTiers(model, {
    inputTokens: usage.input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
  });
}
