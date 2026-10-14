import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * #868 · the model reads an opt-out from any wording (Barton, 2026-10-11).
 *
 * No word list and no fixed reply: the `opt-out-read` skill decides stop / start /
 * none and writes the confirmation in the sender's language. The carrier-required
 * STOP keyword path in machine.ts still revokes first; this reader catches every
 * other way a person says it. A failed or unusable read returns null, and the
 * caller treats null as "not an opt-out" only because the keyword path already ran.
 * The verbatim echo is a structural guard: a model that paraphrased the text did
 * not read it, so its verdict is dropped.
 *
 * The same read routes a crisis (#868, Sloane 2026-10-14): an emergency or a
 * mental-health crisis in any wording comes back as `crisis_*` with the model's own
 * reply pointing to emergency or crisis help. One call per inbound covers both, and
 * {@link readTurnOnce} shares it across every seam that asks within one turn.
 */

const MAX_TOKENS = 400;

export type OptOutIntent = 'stop' | 'start' | 'crisis_emergency' | 'crisis_mental' | 'none';

const INTENTS = ['stop', 'start', 'crisis_emergency', 'crisis_mental', 'none'] as const;

export interface OptOutReading {
  intent: OptOutIntent;
  /** Model-written reply: the stop/start confirmation, or the crisis reply. Empty for none. */
  confirmation: string;
}

export interface OptOutReader {
  read(input: { text: string; language: ReplyLanguage | null }): Promise<OptOutReading | null>;
}

const outputSchema = z.object({
  intent: z.enum(INTENTS),
  verbatim: z.string(),
  confirmation: z.string(),
});

const outputJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    verbatim: { type: 'string' },
    confirmation: { type: 'string' },
  },
  required: ['intent', 'verbatim', 'confirmation'],
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function optOutUserMessage(input: { text: string; language: ReplyLanguage | null }): string {
  return JSON.stringify({ text: input.text, threadLanguage: input.language });
}

/** Structural checks only: echo must match. A crisis reading with no reply is kept
 * (the caller ends the turn and logs it) — the routing still stands. */
export function acceptOptOutReading(
  value: z.infer<typeof outputSchema>,
  text: string,
): OptOutReading | null {
  if (value.verbatim !== text) return null;
  const confirmation = value.confirmation.trim();
  if (value.intent === 'none') return { intent: 'none', confirmation: '' };
  return { intent: value.intent, confirmation };
}

export function createOptOutReader(client: AgentClient): OptOutReader {
  return {
    async read(input) {
      try {
        const skill = await loadCronSkill('opt-out-read');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: optOutUserMessage(input),
          toolName: 'opt_out',
          toolDescription: 'Return whether the sender asked Hale to stop or start texting.',
          inputJsonSchema: outputJsonSchema,
          schema: outputSchema,
          maxTokens: MAX_TOKENS,
        });
        return acceptOptOutReading(value, input.text);
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'opt-out reader: read failed',
        );
        return null;
      }
    },
  };
}

/** Test and dry-run double: never calls a model. */
export const optOutReaderIdle: OptOutReader = {
  read: async () => ({ intent: 'none', confirmation: '' }),
};

const turnReads = new WeakMap<object, Promise<OptOutReading | null>>();

/**
 * One read per inbound, however many seams ask. Keyed by the inbound object, so a
 * new turn always reads afresh and nothing outlives the turn.
 */
export function readTurnOnce(
  reader: OptOutReader | null | undefined,
  turn: object,
  input: { text: string; language: ReplyLanguage | null },
): Promise<OptOutReading | null> {
  if (!reader || input.text.trim().length === 0) return Promise.resolve(null);
  const cached = turnReads.get(turn);
  if (cached) return cached;
  const read = reader.read(input);
  turnReads.set(turn, read);
  return read;
}

export function isCrisisReading(
  reading: OptOutReading | null,
): reading is OptOutReading & { intent: 'crisis_emergency' | 'crisis_mental' } {
  return reading?.intent === 'crisis_emergency' || reading?.intent === 'crisis_mental';
}
