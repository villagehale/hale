import { type AgentClient, type Skill, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-524 / VIL-567 · whether this inbound is a nearby-find, so the private-find
 * and find-day addenda compose.
 *
 * A model reads the parent's words in any language. There is no word list. A calendar
 * edit or a read of their own calendar is not a find, even when it names a weekend.
 * A missing client, a missing skill, or a model failure is `not_find` (rule #11): the
 * standing coach prompt still answers, and a wrong `find` would search when they meant
 * to edit.
 */

export const FIND_TURN_MAX_TOKENS = 128;
export const FIND_TURN_TOOL = 'find_turn';
export const FIND_TURN_TOOL_DESCRIPTION = 'Whether this turn is a nearby-find ask.';
export const FIND_TURN_SKILL = 'coach-find-turn';

/** One inbound body, not a paste. Bound here so a long Linq text cannot blow the read. */
const MAX_TEXT_CHARS = 4000;
/** Earlier user turns the reader may see. Enough for a find, then a follow-up. */
const MAX_PRIOR_TURNS = 6;

export type FindTurnIntent = 'find' | 'not_find';

export interface FindTurnReading {
  findTurn: boolean;
}

export interface FindTurnReader {
  read(input: {
    text: string;
    transcript: readonly { role: string; content: string }[];
  }): Promise<FindTurnReading>;
}

export const findTurnSchema = z.object({
  intent: z.string(),
  reason: z.string().optional(),
});

export const FIND_TURN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      enum: ['find', 'not_find'],
      description: 'find only when this turn is a nearby-find ask or a follow-up to one.',
    },
    reason: { type: 'string' },
  },
  required: ['intent'],
} as const;

function priorUserTurns(
  text: string,
  transcript: readonly { role: string; content: string }[],
): string[] {
  const users = transcript
    .filter((message) => message.role === 'user')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  if (users.length > 0 && users[users.length - 1] === text.trim()) users.pop();
  return users.slice(-MAX_PRIOR_TURNS).map((content) => content.slice(0, MAX_TEXT_CHARS));
}

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function findTurnUserMessage(
  text: string,
  transcript: readonly { role: string; content: string }[],
): string {
  return JSON.stringify({
    text: text.slice(0, MAX_TEXT_CHARS),
    prior: priorUserTurns(text, transcript),
  });
}

export function toFindTurnReading(raw: { intent: string }): FindTurnReading {
  return { findTurn: raw.intent === 'find' };
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function notFind(reason: string, detail?: string): FindTurnReading {
  console.info({ reason, detail }, 'find turn: not a find, standing prompt');
  return { findTurn: false };
}

/**
 * `client` is a resolver, not a value. These deps are built for every inbound text,
 * including the ones a deterministic handler answers with no model at all, so a missing
 * key must not throw.
 */
export function createFindTurnReader(client: () => AgentClient): FindTurnReader {
  return {
    async read({ text, transcript }) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return notFind('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(FIND_TURN_SKILL);
      } catch (err) {
        return notFind('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: findTurnUserMessage(text, transcript),
          toolName: FIND_TURN_TOOL,
          toolDescription: FIND_TURN_TOOL_DESCRIPTION,
          inputJsonSchema: FIND_TURN_TOOL_SCHEMA,
          schema: findTurnSchema,
          maxTokens: FIND_TURN_MAX_TOKENS,
        });
        return toFindTurnReading(value);
      } catch (err) {
        return notFind('model_failed', message(err));
      }
    },
  };
}

/** `null` returns the same skill object, so a non-find turn's prompt is unchanged. */
export function augmentCoachSkillForFindPrivate(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return {
    ...skill,
    instructions: `${skill.instructions}\n\n${addendum.instructions}`,
  };
}
