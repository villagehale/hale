import type { AgentUsage } from './agent.js';
import { DEEPSEEK_MODEL, HAIKU_MODEL, type ModelId, OPUS_MODEL, SONNET_MODEL } from './model.js';

/**
 * The one place a token becomes a dollar. Both processes price through here —
 * the worker's `estimateCostUsd` adapter over the raw SDK usage, and the web's
 * `agentRunCostUsd` over a finished loop — because a second copy of this
 * arithmetic drifted: the web copies dropped the cache tiers entirely and booked
 * every cached step at $0 for the loop-health $/family telemetry.
 *
 * Per-model token rates, USD per million tokens.
 * Source: platform.claude.com/docs/en/about-claude/pricing, read 2026-10-11:
 * Sonnet 5.5 $2 in / $10 out, Opus 5.5 $4 / $20 — both with cache hits at 0.05x
 * input, not the usual 0.1x. Haiku 5.5 has two cards chosen by the call's prompt
 * length (all input tokens, cache reads and writes included): $0.10 / $0.50 up to
 * 100K tokens, $0.50 / $2.50 above, each with the usual 0.1x read / 1.25x write.
 * DeepSeek V4.1 Flash is priced from its Vercel AI Gateway model page at
 * $0.15 input / $0.60 output / $0.003 cached input per MTok.
 * Hardcoded by design — billing accuracy is a point-in-time estimate, not a
 * live lookup; rotate these constants when public pricing changes. Keyed by
 * ModelId so a new tier in model.ts cannot ship without its rate.
 */
interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

const RATES: Record<ModelId, ModelRate> = {
  [SONNET_MODEL]: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1 },
  [OPUS_MODEL]: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 },
  [HAIKU_MODEL]: { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  [DEEPSEEK_MODEL]: {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.003,
    cacheWritePerMTok: 0.15,
  },
};

/**
 * Haiku 5.5 above 100K prompt tokens. The card is chosen per request, so a priced
 * {@link agentRunCostUsd} loop — whose usage is summed over its steps — is an upper
 * bound when its steps together pass the threshold but none does alone.
 */
const HAIKU_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_LONG_PROMPT_RATE: ModelRate = { inputPerMTok: 0.5, outputPerMTok: 2.5 };

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
  const listed = RATES[model as ModelId];
  if (!listed) {
    throw new Error(`estimateCostUsd: no rate configured for model '${model}'`);
  }
  const promptTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const rate =
    model === HAIKU_MODEL && promptTokens > HAIKU_LONG_PROMPT_TOKENS
      ? HAIKU_LONG_PROMPT_RATE
      : listed;
  const cacheReadPerMTok = rate.cacheReadPerMTok ?? rate.inputPerMTok * CACHE_READ_RATE_MULTIPLIER;
  const cacheWritePerMTok =
    rate.cacheWritePerMTok ?? rate.inputPerMTok * CACHE_WRITE_RATE_MULTIPLIER;
  return (
    (usage.inputTokens * rate.inputPerMTok) / PER_MTOK +
    (usage.cacheCreationTokens * cacheWritePerMTok) / PER_MTOK +
    (usage.cacheReadTokens * cacheReadPerMTok) / PER_MTOK +
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
