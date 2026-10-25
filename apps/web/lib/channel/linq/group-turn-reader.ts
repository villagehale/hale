import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { GroupTurnDecision } from './group-turn-policy';

/**
 * VIL-440 (T27) — the model reads whether a group message is Hale's turn.
 *
 * Replaces name and keyword matching (`decideGroupTurn`) when
 * `LINQ_GROUP_TURN_AI_ENABLED` is exactly `true` (default off). Code owns the routing;
 * the `group-turn-read` skill reads the words in any language. The verbatim echo is a
 * structural guard: a paraphrase means the text was not read. A failed read keeps Hale
 * silent (one unasked reply in a family chat is worse than one missed turn) and logs.
 */

export const GROUP_TURNS = ['addressed', 'question_for_hale', 'duty', 'chatter'] as const;
export type GroupTurnReading = (typeof GROUP_TURNS)[number];

export interface GroupTurnReadInput {
  text: string;
  senderName: string | null;
  haleNames: readonly string[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface GroupTurnReader {
  /** Null: the read failed after its retry. */
  read(input: GroupTurnReadInput): Promise<GroupTurnReading | null>;
}

const outputSchema = z.object({ turn: z.enum(GROUP_TURNS), verbatim: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { turn: { type: 'string', enum: [...GROUP_TURNS] }, verbatim: { type: 'string' } },
  required: ['turn', 'verbatim'],
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function groupTurnUserMessage(input: GroupTurnReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderName: input.senderName,
    haleNames: [...input.haleNames],
    recent: input.recent.slice(-6),
  });
}

export function linqGroupTurnAiEnabled(): boolean {
  return process.env.LINQ_GROUP_TURN_AI_ENABLED?.trim() === 'true';
}

/** Map a reading (or a failed read) to the door's route. Opt-out still wins first. */
export function groupTurnFromReading(
  reading: GroupTurnReading | null,
  optOut: 'stop' | 'start' | null,
): GroupTurnDecision {
  if (optOut) return { route: 'keyword', keyword: optOut };
  if (reading === 'addressed') return { route: 'coach', reason: 'addressed' };
  if (reading === 'question_for_hale') return { route: 'coach', reason: 'question' };
  if (reading === 'duty') return { route: 'duty' };
  return { route: 'ignore', outcome: 'group_chatter_ignored' };
}

export function createGroupTurnReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupTurnReader {
  const once = async (input: GroupTurnReadInput): Promise<GroupTurnReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-turn-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupTurnUserMessage(input),
      toolName: 'group_turn',
      toolDescription: 'Return whether this group message is for Hale.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: 200,
    });
    return value.verbatim === input.text ? value.turn : null;
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
            'group turn reader: read failed',
          );
        }
      }
      console.error({ outcome: 'group_turn_unread' }, 'group turn reader: staying silent');
      return null;
    },
  };
}

let shared: GroupTurnReader | null = null;

export function sharedGroupTurnReader(): GroupTurnReader {
  shared ??= createGroupTurnReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}
