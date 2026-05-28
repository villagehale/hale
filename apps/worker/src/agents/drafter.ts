import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import type { ActionType, DraftedAction } from '@haru/types';
import { sonnetModel } from '../mastra/model.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';

const drafterOutputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  recipient_visibility: z.enum(['public', 'internal_only']),
});

interface DrafterRunInput {
  familyId: string;
  event: {
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  };
  actionType: ActionType;
  memorySlice?: {
    relevantFacts: unknown[];
    relevantEpisodes: unknown[];
  };
  voiceProfile?: unknown;
  actionTemplateHint?: string;
}

interface DrafterRunOutput extends DraftedAction {
  agentRunId: string;
}

export async function runDrafter(input: DrafterRunInput): Promise<DrafterRunOutput> {
  const instructions = await loadPrompt('drafter');
  const agent = new Agent({
    id: 'haru-drafter',
    name: 'haru-drafter',
    instructions,
    model: sonnetModel(),
  });

  const userMessage = JSON.stringify({
    action_type: input.actionType,
    event: input.event,
    memory_slice: input.memorySlice ?? null,
    voice_profile: input.voiceProfile ?? null,
    action_template_hint: input.actionTemplateHint ?? null,
  });

  const result = await agent.generate(userMessage, {
    structuredOutput: { schema: drafterOutputSchema },
  });

  const parsed = result.object;
  if (!parsed) {
    logger.error({ familyId: input.familyId }, 'drafter: agent returned no structured output');
    throw new Error('Drafter produced no structured output');
  }

  return {
    id: crypto.randomUUID(),
    eventId: input.event.eventId,
    familyId: input.familyId,
    actionType: input.actionType,
    payload: parsed.payload,
    draftConfidence: parsed.confidence,
    rationale: parsed.rationale,
    recipientVisibility: parsed.recipient_visibility,
    draftedAt: new Date().toISOString(),
    agentRunId: crypto.randomUUID(),
  };
}
