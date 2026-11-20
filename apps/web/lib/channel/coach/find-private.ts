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
 * A missing client, a missing skill, a model failure or an intent off the enum is not a
 * find either, so the standing coach prompt still answers and a wrong `find` never
 * searches when they meant to edit. Each of those is its own named reason, apart from
 * the model's own `not_find`, and is logged at warn (rule #11).
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

/** Why a turn is not a find: the model's own reading, or the read that failed. */
export type FindTurnNotFindReason =
  | 'not_find'
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'off_enum_intent';

export type FindTurnReading =
  | { findTurn: true }
  | { findTurn: false; reason: FindTurnNotFindReason };

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
  if (raw.intent === 'find') return { findTurn: true };
  if (raw.intent === 'not_find') return { findTurn: false, reason: 'not_find' };
  // The value is model output, so it is not logged (rule #1).
  return readFailed('off_enum_intent');
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function readFailed(
  reason: Exclude<FindTurnNotFindReason, 'not_find'>,
  detail?: string,
): FindTurnReading {
  console.warn({ reason, detail }, 'find turn: read failed, standing prompt');
  return { findTurn: false, reason };
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
        return readFailed('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(FIND_TURN_SKILL);
      } catch (err) {
        return readFailed('skill_unavailable', message(err));
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
        return readFailed('model_failed', message(err));
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
