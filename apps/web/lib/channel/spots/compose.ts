import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  SPOT_OPEN_MAX_ATTEMPTS,
  SPOT_OPEN_MAX_TOKENS,
  SPOT_OPEN_SKILL,
  SPOT_OPEN_TOOL,
  SPOT_OPEN_TOOL_DESCRIPTION,
  SPOT_OPEN_TOOL_SCHEMA,
  type SpotOpenFacts,
  spotOpenRefusals,
  spotOpenUserMessage,
} from './copy';

const outputSchema = z.object({ text: z.string() });

/**
 * VIL-337 · the spot-opened text, written by the model from facts (copy.ts). Null is
 * nothing sent: a refused or failed draft, after the last attempt, has no fallback.
 * Logs carry the family, the attempt and refusal codes only — never the label or text.
 */
export async function composeSpotOpen(
  client: AgentClient,
  facts: SpotOpenFacts,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(SPOT_OPEN_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'watched spots: spot-open skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= SPOT_OPEN_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: spotOpenUserMessage(facts),
        toolName: SPOT_OPEN_TOOL,
        toolDescription: SPOT_OPEN_TOOL_DESCRIPTION,
        inputJsonSchema: SPOT_OPEN_TOOL_SCHEMA,
        schema: outputSchema,
        maxTokens: SPOT_OPEN_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = spotOpenRefusals(text, facts);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'watched spots: spot-open draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'watched spots: spot-open compose failed',
      );
    }
  }
  console.error({ familyId, outcome: 'spot_open_unwritten' }, 'watched spots: nothing sent');
  return null;
}
