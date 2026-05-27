import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic } from '../anthropic.js';
import { loadPrompt } from '../prompts/loader.js';
import { logger } from '../logger.js';
import type { ActionType, DraftedAction } from '@mira/types';

const DRAFTER_MODEL = 'claude-sonnet-4-6';

const drafterOutputSchema = z.object({
  payload: z.record(z.unknown()),
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
  const systemPrompt = await loadPrompt('drafter');

  const userMessage = JSON.stringify({
    action_type: input.actionType,
    event: input.event,
    memory_slice: input.memorySlice ?? null,
    voice_profile: input.voiceProfile ?? null,
    action_template_hint: input.actionTemplateHint ?? null,
  });

  const response = await anthropic().messages.create({
    model: DRAFTER_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const parsed = drafterOutputSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    logger.error(
      { familyId: input.familyId, raw: text, errors: parsed.error.flatten() },
      'drafter: invalid JSON output',
    );
    throw new Error(`Drafter returned invalid JSON: ${parsed.error.message}`);
  }

  return {
    id: crypto.randomUUID(),
    eventId: input.event.eventId,
    familyId: input.familyId,
    actionType: input.actionType,
    payload: parsed.data.payload,
    draftConfidence: parsed.data.confidence,
    rationale: parsed.data.rationale,
    recipientVisibility: parsed.data.recipient_visibility,
    draftedAt: new Date().toISOString(),
    agentRunId: crypto.randomUUID(),
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('drafter output contained no JSON');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
