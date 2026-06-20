/**
 * Ask Hale run metrics — the cost/latency shape recorded per Q&A run for spend
 * tracking. The bespoke single Anthropic call that used to live here was replaced
 * by the stateful agent on the @hale/agent harness (see agent.ts); this type is
 * what askHale produces and recordCoachRun persists into agent_runs.
 */
export interface CoachRunMetrics {
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}
