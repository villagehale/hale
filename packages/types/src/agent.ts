/**
 * Names of the LLM agents in the system. Aligned with the agentNameEnum in db.
 */
export type AgentName = 'classifier' | 'drafter' | 'coach' | 'reviewer' | 'memory_inferencer';

export interface AgentRunMetrics {
  agentName: AgentName;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  promptCacheHit: boolean;
}
