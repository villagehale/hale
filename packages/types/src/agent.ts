/**
 * Names of the LLM agents in the system. Aligned with the agentNameEnum in db.
 */
export type AgentName = 'classifier' | 'drafter' | 'coach' | 'reviewer' | 'memory_inferencer';

/**
 * Models used by each agent. Pinned versions to prevent surprise behavior changes.
 */
export type AgentModel =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-sonnet-4-6-extended-thinking';

/** Default model routing per agent. */
export const AGENT_MODEL: Record<AgentName, AgentModel> = {
  classifier: 'claude-haiku-4-5-20251001',
  drafter: 'claude-sonnet-4-6',
  coach: 'claude-sonnet-4-6',
  reviewer: 'claude-sonnet-4-6',
  memory_inferencer: 'claude-sonnet-4-6',
};

export interface AgentRunMetrics {
  agentName: AgentName;
  modelUsed: AgentModel;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  promptCacheHit: boolean;
}
