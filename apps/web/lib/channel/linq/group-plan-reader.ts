import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

export type GroupPlanOptionFact = {
  id: string;
  name: string;
  when: string | null;
  where: string | null;
};

/**
 * VIL-441 (T14) — the model reads whether a group message or tapback is a
 * plan-together ask or a yes / no / maybe. No keyword matching. A failed read
 * changes no state.
 */

export const GROUP_PLAN_INTENTS = [
  'plan_ask',
  'yes',
  'no',
  'maybe',
  'unclear',
  'chatter',
] as const;
export type GroupPlanIntent = (typeof GROUP_PLAN_INTENTS)[number];

export type GroupPlanReading = {
  intent: GroupPlanIntent;
  optionId: string | null;
  subject: string | null;
  confidence: 'high' | 'low';
};

export type GroupPlanReadInput = {
  text: string;
  reactionType: string | null;
  senderName: string | null;
  options: readonly GroupPlanOptionFact[];
  answered: readonly { name: string | null; stance: string }[];
};

export interface GroupPlanReader {
  /** Null: the read failed after its retry. */
  read(input: GroupPlanReadInput): Promise<GroupPlanReading | null>;
}

const outputSchema = z.object({
  intent: z.enum(GROUP_PLAN_INTENTS),
  optionId: z.string().nullable(),
  subject: z.string().nullable(),
  confidence: z.enum(['high', 'low']),
});

const outputJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...GROUP_PLAN_INTENTS] },
    optionId: { type: ['string', 'null'] },
    subject: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['intent', 'optionId', 'subject', 'confidence'],
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function groupPlanUserMessage(input: GroupPlanReadInput): string {
  return JSON.stringify({
    text: input.text,
    reactionType: input.reactionType,
    senderName: input.senderName,
    options: input.options.map((option) => ({
      id: option.id,
      name: option.name,
      when: option.when,
      where: option.where,
    })),
    answered: input.answered,
  });
}

export function createGroupPlanReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupPlanReader {
  const once = async (input: GroupPlanReadInput): Promise<GroupPlanReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-plan-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupPlanUserMessage(input),
      toolName: 'group_plan',
      toolDescription: 'Return whether this group message is a plan ask or a yes/no/maybe.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: 200,
    });
    return {
      intent: value.intent,
      optionId: value.optionId,
      subject: value.subject,
      confidence: value.confidence,
    };
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group plan reader: read failed',
          );
        }
      }
      console.error({ outcome: 'group_plan_unread' }, 'group plan reader: no state change');
      return null;
    },
  };
}

let shared: GroupPlanReader | null = null;

export function sharedGroupPlanReader(): GroupPlanReader {
  shared ??= createGroupPlanReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/** A stance the code may store. Low confidence and chatter never land here. */
export function stanceFromReading(
  reading: GroupPlanReading | null,
): { stance: 'yes' | 'no' | 'maybe'; optionId: string | null } | null {
  if (!reading || reading.confidence !== 'high') return null;
  if (reading.intent !== 'yes' && reading.intent !== 'no' && reading.intent !== 'maybe') {
    return null;
  }
  return { stance: reading.intent, optionId: reading.optionId };
}
