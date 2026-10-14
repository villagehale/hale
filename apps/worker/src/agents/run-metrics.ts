import type Anthropic from '@anthropic-ai/sdk';
import type { AgentName } from '@hale/types';
import { estimateCostUsd } from '../anthropic/cost.js';

/**
 * What one raw-SDK agent call produced, beyond its parsed output: the data an
 * `agent_runs` row needs. Agent functions return this so the orchestrator can
 * persist runs (B8) — the LLM-call code never touches the DB itself.
 */
export interface AgentRunMetrics {
  agentName: AgentName;
  modelUsed: string;
  /** Fresh input plus cache writes: every token billed at or above the full rate. */
  promptTokens: number;
  completionTokens: number;
  /** Undefined is stored as NULL: this call did not measure the cache. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  latencyMs: number;
}

/** Builds metrics from a finished SDK call: usage + measured latency. */
export function metricsFromUsage(
  agentName: AgentName,
  model: string,
  usage: Anthropic.Usage,
  latencyMs: number,
): AgentRunMetrics {
  return {
    agentName,
    modelUsed: model,
    promptTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
    completionTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: estimateCostUsd(model, usage),
    latencyMs,
  };
}
