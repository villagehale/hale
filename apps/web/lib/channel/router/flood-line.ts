import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE OVER-LIMIT LINE (VIL-463) — what a parent gets, 1:1, when they write in a group
 * and their own hourly turn budget is spent.
 *
 * Composed from facts, never recited: no preset body and no fallback. The skill sees only
 * the situation and the language, never the group or anything anyone wrote. When no line
 * can be written, NOTHING is sent and the outcome says why.
 */

/** The ledger's name for this line, so a read-back can tell it from a turn's answer. */
export const FLOOD_LINE_TEMPLATE_KEY = 'flood_line';

const MAX_TOKENS = 96;

export type FloodLineFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'empty';

export type FloodLineCompose =
  | { status: 'composed'; line: string }
  | { status: 'unavailable'; reason: FloodLineFallback };

export interface FloodLineComposer {
  compose(language: ReplyLanguage | null): Promise<FloodLineCompose>;
}

/** The user-turn payload: facts only. */
export function floodLineUserMessage(language: ReplyLanguage | null): string {
  return JSON.stringify({
    situation: 'many_texts_at_once',
    where_they_wrote: 'a group chat',
    where_this_goes: 'only to them, privately',
    language,
  });
}

const lineSchema = z.object({ line: z.string() });
const lineJsonSchema = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
} as const;

/** The production composer, on a lazily resolved client like the holding line's. */
export function createFloodLine(client: () => AgentClient): FloodLineComposer {
  return {
    async compose(language) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        // No detail on purpose: a provider error can carry the request back (rule #1).
        return { status: 'unavailable', reason: 'client_unavailable' };
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('flood-line');
      } catch {
        return { status: 'unavailable', reason: 'skill_unavailable' };
      }
      let raw: string;
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: floodLineUserMessage(language),
          toolName: 'flood_line',
          toolDescription: 'Return the one private line the parent gets.',
          inputJsonSchema: lineJsonSchema,
          schema: lineSchema,
          maxTokens: MAX_TOKENS,
        });
        raw = value.line;
      } catch {
        return { status: 'unavailable', reason: 'model_failed' };
      }
      const line = plainText(raw);
      if (line === '') return { status: 'unavailable', reason: 'empty' };
      return { status: 'composed', line };
    },
  };
}
