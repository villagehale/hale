import type { AgentUsage } from './agent.js';
import { HAIKU_MODEL, type ModelId, OPUS_MODEL, SONNET5_MODEL, SONNET_MODEL } from './model.js';

/**
 * The one place a token becomes a dollar. Both processes price through here —
 * the worker's `estimateCostUsd` adapter over the raw SDK usage, and the web's
 * `agentRunCostUsd` over a finished loop — because a second copy of this
 * arithmetic drifted: the web copies dropped the cache tiers entirely and booked
 * every cached step at $0 for the loop-health $/family telemetry.
 *
 * Per-model token rates, USD per million tokens.
 * Source: Anthropic pricing (platform.claude.com/docs models overview):
 * Sonnet 4.6 $3 in / $15 out; Sonnet 5 $3 in / $15 out list ($2/$10 intro
 * through 2026-08-31); Haiku 4.5 $1 in / $5 out; Opus 5 $5 in / $25 out —
 * unchanged from the Opus 4.8 it replaced, so the re-tier moved the id under
 * this key without moving the rate. Sonnet 5 is booked at LIST, not the intro
 * price: an estimate that silently halves when a promotion lapses is worse than
 * one that is consistently conservative.
 * Hardcoded by design — billing accuracy is a point-in-time estimate, not a
 * live lookup; rotate these constants when public pricing changes. Keyed by
 * ModelId so a new tier in model.ts cannot ship without its rate.
 */
interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

const RATES: Record<ModelId, ModelRate> = {
  [SONNET_MODEL]: { inputPerMTok: 3, outputPerMTok: 15 },
  [SONNET5_MODEL]: { inputPerMTok: 3, outputPerMTok: 15 },
  [HAIKU_MODEL]: { inputPerMTok: 1, outputPerMTok: 5 },
  [OPUS_MODEL]: { inputPerMTok: 5, outputPerMTok: 25 },
};

const PER_MTOK = 1_000_000;

/** Prompt-cache reads bill at 0.1x the base input rate (Anthropic pricing). */
const CACHE_READ_RATE_MULTIPLIER = 0.1;

/** Writing the 5-minute prompt cache bills at 1.25x the base input rate. */
const CACHE_WRITE_RATE_MULTIPLIER = 1.25;

/**
 * One call's tokens, split the way Anthropic bills them: fresh prompt tokens at
 * the full input rate, cache writes at 1.25x, cache reads at 0.1x, output at the
 * output rate. The tiers are disjoint — a token is counted in exactly one.
 */
export interface TokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

/** USD for one call's tokens. Throws on a model with no configured rate. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rate = RATES[model as ModelId];
  if (!rate) {
    throw new Error(`estimateCostUsd: no rate configured for model '${model}'`);
  }
  return (
    (usage.inputTokens * rate.inputPerMTok) / PER_MTOK +
    (usage.cacheCreationTokens * rate.inputPerMTok * CACHE_WRITE_RATE_MULTIPLIER) / PER_MTOK +
    (usage.cacheReadTokens * rate.inputPerMTok * CACHE_READ_RATE_MULTIPLIER) / PER_MTOK +
    (usage.outputTokens * rate.outputPerMTok) / PER_MTOK
  );
}

/** USD for a finished {@link runAgent} loop, whose `promptTokens` is the merged
 * full-rate total (fresh input + cache writes) the agent_runs row records. */
export function agentRunCostUsd(model: string, usage: AgentUsage): number {
  return estimateCostUsd(model, {
    inputTokens: usage.promptTokens - usage.cacheCreationTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    outputTokens: usage.completionTokens,
  });
}
