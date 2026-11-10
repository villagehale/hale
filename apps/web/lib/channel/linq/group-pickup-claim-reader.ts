import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  GROUP_PICKUP_CLAIM_INTENTS,
  GROUP_PICKUP_CLAIM_MAX_TOKENS,
  GROUP_PICKUP_CLAIM_TOOL,
  type GroupPickupClaimReader,
  groupPickupClaimUserMessage,
} from './group-pickup-claim';

/**
 * VIL-444 (T24) — the model reads a group message for a pickup claim (skill
 * `group-pickup-claim-read`). Two tries, then null: nothing is stored, and the clash alert
 * stands. Part of PR #938's shared reader once it lands (the hook in group-pickup-claim.ts).
 */

const outputSchema = z.object({
  intent: z.enum(GROUP_PICKUP_CLAIM_INTENTS),
  pickupRefs: z.array(z.string()),
  confidence: z.enum(['high', 'low']),
});

export function createGroupPickupClaimReader(client: () => AgentClient): GroupPickupClaimReader {
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const skill = await loadCronSkill('group-pickup-claim-read');
          const { value } = await forceToolJson({
            client: client(),
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: groupPickupClaimUserMessage(input),
            toolName: GROUP_PICKUP_CLAIM_TOOL.name,
            toolDescription: GROUP_PICKUP_CLAIM_TOOL.description,
            inputJsonSchema: GROUP_PICKUP_CLAIM_TOOL.inputSchema,
            schema: outputSchema,
            maxTokens: GROUP_PICKUP_CLAIM_MAX_TOKENS,
          });
          return value;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group pickup claim: read failed',
          );
        }
      }
      console.error({ outcome: 'group_pickup_claim_unread' }, 'group pickup claim: nothing stored');
      return null;
    },
  };
}

let shared: GroupPickupClaimReader | null = null;

export function sharedGroupPickupClaimReader(): GroupPickupClaimReader {
  shared ??= createGroupPickupClaimReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}
