import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { FamilySnapshot } from './snapshot';
import {
  DECIDER_MAX_TOKENS,
  DECIDER_TOOL,
  DECIDER_TOOL_SCHEMA,
  type DeciderDecision,
  parseDeciderDecision,
} from './tools';

/**
 * VIL-226 · one per-family decision: send now, hold, or drop, and which queued items.
 * The skill (`proactive-decider.md`) is the guidance; this file shapes the call, checks
 * the answer, and refuses to call the model at all when the queue is empty.
 */

export const DECIDER_SKILL = 'proactive-decider';

export { DECIDER_TOOL_SCHEMA, type DeciderDecision, parseDeciderDecision };

export type DecideSkip = 'empty_queue' | 'no_client' | 'model_failed' | 'unparsed';

export interface DecideResult {
  decision: DeciderDecision | null;
  skipped: DecideSkip | null;
}

/**
 * Never calls the model when `candidates` is empty. A null client is a named skip, not
 * a send. A failed or malformed call is a named skip, logged without the snapshot.
 */
export async function decideForFamily(input: {
  snapshot: FamilySnapshot;
  client: AgentClient | null;
}): Promise<DecideResult> {
  if (input.snapshot.candidates.length === 0) return { decision: null, skipped: 'empty_queue' };
  if (!input.client) return { decision: null, skipped: 'no_client' };
  const skill = await loadCronSkill(DECIDER_SKILL);
  let value: unknown;
  try {
    const result = await forceToolJson({
      client: input.client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: JSON.stringify(input.snapshot),
      toolName: DECIDER_TOOL,
      toolDescription: 'Your one decision for this family right now.',
      inputJsonSchema: DECIDER_TOOL_SCHEMA,
      schema: z.unknown(),
      maxTokens: DECIDER_MAX_TOKENS,
    });
    value = result.value;
  } catch (err) {
    // Never the message: a provider 400 can quote the request, parent words and all.
    console.error(
      { err: err instanceof Error ? err.constructor.name : 'unknown' },
      'proactive decider: model call failed',
    );
    return { decision: null, skipped: 'model_failed' };
  }
  const decision = parseDeciderDecision(value);
  if (!decision) return { decision: null, skipped: 'unparsed' };
  return { decision, skipped: null };
}
