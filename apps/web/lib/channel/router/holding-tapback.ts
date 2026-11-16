import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ParentReaction, readParentReaction } from '~/lib/channel/linq/tapback';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { HoldingLineFallback } from './holding-line';

/**
 * THE HOLDING TAPBACK — the 1:1 iMessage wait-ack (VIL-680).
 *
 * Past {@link HOLDING_LINE_AFTER_MS}, one tapback lands on the parent's message
 * while the answer is still being written. No words. A composer that cannot pick
 * a sendable reaction, or a send that does not land, sends nothing.
 */

export function holdingTapbackUserMessage(): string {
  return JSON.stringify({ situation: 'answer_still_coming' });
}

export type HoldingTapbackCompose =
  | { status: 'composed'; reaction: ParentReaction }
  | { status: 'unavailable'; reason: HoldingLineFallback };

export interface HoldingTapbackComposer {
  compose(): Promise<HoldingTapbackCompose>;
}

const reactionSchema = z.object({ reaction: z.string() });
const reactionJsonSchema = {
  type: 'object',
  properties: { reaction: { type: 'string' } },
  required: ['reaction'],
} as const;

const MAX_TOKENS = 32;

function unavailable(reason: HoldingLineFallback, detail?: string): HoldingTapbackCompose {
  console.error({ reason, detail }, 'holding tapback: no reaction composed');
  return { status: 'unavailable', reason };
}

/** The production composer, on a lazily resolved client like the holding line's. */
export function createHoldingTapback(client: () => AgentClient): HoldingTapbackComposer {
  return {
    async compose() {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        return unavailable('client_unavailable');
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('holding-tapback');
      } catch {
        return unavailable('skill_unavailable');
      }
      let raw: string;
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: holdingTapbackUserMessage(),
          toolName: 'holding_tapback',
          toolDescription: 'Return the one tapback while the answer is coming.',
          inputJsonSchema: reactionJsonSchema,
          schema: reactionSchema,
          maxTokens: MAX_TOKENS,
        });
        raw = value.reaction;
      } catch {
        return unavailable('model_failed');
      }
      const reaction = readParentReaction(raw);
      if (!reaction || reaction.type === 'custom') {
        return unavailable('gate_exhausted', raw);
      }
      if (reaction.type === 'dislike' || reaction.type === 'question') {
        return unavailable('gate_exhausted', reaction.type);
      }
      return { status: 'composed', reaction };
    },
  };
}
