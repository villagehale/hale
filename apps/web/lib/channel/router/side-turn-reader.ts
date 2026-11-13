import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { LocalNow } from '~/lib/channel/coach/local-now';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * CAN THIS TEXT BE ANSWERED NOW, WHILE HALE IS STILL ON THE LAST ONE (inbound-side-turn).
 *
 * A parent's turn is still running when they text again. Whether the new text stands on
 * its own — a quick question that needs only words — or belongs to the turn in front of
 * it (a correction, a "yes", a new ask that needs a change) is reading, so the model does
 * it, in any language. When it stands on its own, the same call writes the short answer.
 *
 * It sees the new text, what Hale is still answering, the end of the thread, what Hale is
 * waiting to hear back about, and the family as the coach is told it (rule #1: teenagers
 * by stage only). It changes nothing. A reader that cannot run says why by name, and the
 * text waits its turn as it does today.
 */

export interface SideTurnFamily {
  /** The end of this parent's 1:1 thread, oldest first. */
  thread: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  /** The children as the coach sees them: a teenager is a stage, never a name or an age.
   * An age is given in years and months, so the model reads it rather than works it out. */
  children: ReadonlyArray<{
    name: string | null;
    stage: string;
    age: { years: number; months: number } | null;
  }>;
  city: string | null;
  /** The coach's memory brief, or null when there is none. */
  memory: string | null;
  /** Today where the family lives, or null when the zone is unknown. */
  localNow: LocalNow | null;
}

export interface SideTurnInput {
  text: string;
  /** The words of the turn Hale is still answering. */
  workingOn: readonly string[];
  /** What Hale is waiting for this parent to answer, in Hale's own words. */
  waitingOn: readonly string[];
  family: SideTurnFamily;
}

export type SideTurnReaderFallback = 'client_unavailable' | 'skill_unavailable' | 'model_failed';

export type SideTurnReading =
  | { status: 'read'; verdict: 'answer'; reply: string }
  | { status: 'read'; verdict: 'hand_back' }
  | { status: 'unavailable'; reason: SideTurnReaderFallback };

export interface SideTurnReader {
  read(input: SideTurnInput): Promise<SideTurnReading>;
}

/** Reasoning first, then a verdict and a reply of a sentence or two. */
const MAX_TOKENS = 1_024;

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function sideTurnUserMessage(input: SideTurnInput): string {
  const { family } = input;
  return JSON.stringify({
    text: input.text,
    workingOn: input.workingOn,
    waitingOn: input.waitingOn,
    thread: family.thread,
    family: { children: family.children, city: family.city, memory: family.memory },
    localNow: family.localNow,
  });
}

const readingSchema = z.object({
  reasoning: z.string(),
  verdict: z.enum(['answer', 'hand_back']),
  reply: z.string(),
});

const readingJsonSchema = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    verdict: { type: 'string', enum: ['answer', 'hand_back'] },
    reply: { type: 'string' },
  },
  required: ['reasoning', 'verdict', 'reply'],
} as const;

function unavailable(reason: SideTurnReaderFallback): SideTurnReading {
  console.warn({ reason }, 'side turn: reader unavailable');
  return { status: 'unavailable', reason };
}

/** The production reader, on a lazily resolved client like the burst reader's. */
export function createSideTurnReader(client: () => AgentClient): SideTurnReader {
  return {
    async read(input) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        // No detail on purpose: a provider error can carry the request back (rule #1).
        return unavailable('client_unavailable');
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('inbound-side-turn');
      } catch {
        return unavailable('skill_unavailable');
      }
      let value: z.infer<typeof readingSchema>;
      try {
        ({ value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: sideTurnUserMessage(input),
          toolName: 'side_turn',
          toolDescription:
            'Say whether this text can be answered now, on its own, and write the answer.',
          inputJsonSchema: readingJsonSchema,
          schema: readingSchema,
          maxTokens: MAX_TOKENS,
        }));
      } catch {
        return unavailable('model_failed');
      }
      return value.verdict === 'answer'
        ? { status: 'read', verdict: 'answer', reply: value.reply.trim() }
        : { status: 'read', verdict: 'hand_back' };
    },
  };
}
