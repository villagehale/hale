import type { AgentClient } from '@hale/agent';

/**
 * An injected client wins, including an explicit null. Undefined means the
 * production voice client, and only when a key is present — otherwise null,
 * and the locked sentence is what leaves.
 */
export async function resolveReplyClient(
  passed: AgentClient | null | undefined,
): Promise<AgentClient | null> {
  if (passed !== undefined) return passed;
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return null;
  const { voiceClient } = await import('~/lib/loop/voice/compose');
  return voiceClient();
}
