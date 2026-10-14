import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * #868 · the model reads an opt-out from any wording (Barton, 2026-10-11).
 *
 * No word list and no fixed reply: the `opt-out-read` skill decides stop / start /
 * none and writes the confirmation in the sender's language, for every word a person
 * uses, STOP included: keywords.ts is gone. A failed read returns null after an
 * urgent log, because nothing else will catch that stop.
 * The verbatim echo is a structural guard: a model that paraphrased the text did
 * not read it, so its verdict is dropped.
 *
 * The same read routes a crisis (#868, Sloane 2026-10-14): an emergency or a
 * mental-health crisis in any wording comes back as `crisis_*` with the model's own
 * reply pointing to emergency or crisis help. One call per inbound covers both, and
 * {@link readTurnOnce} shares it across every seam that asks within one turn.
 */

const MAX_TOKENS = 400;

export type OptOutIntent =
  | 'stop'
  | 'start'
  | 'crisis_emergency'
  | 'crisis_mental'
  | 'identity'
  | 'none';

const INTENTS = ['stop', 'start', 'crisis_emergency', 'crisis_mental', 'identity', 'none'] as const;

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
  // A hint only when certain; the sender's words decide the reply's language (#868).
  return JSON.stringify({ text: input.text, languageHint: certainLanguageHint(input.language) });
}

/** Structural checks only: echo must match. A crisis reading with no reply is kept
 * (the caller ends the turn and logs it) — the routing still stands. */
export function acceptOptOutReading(
  value: z.infer<typeof outputSchema>,
  text: string,
): OptOutReading | null {
  if (value.verbatim !== text) return null;
  const confirmation = value.confirmation.trim();
  if (value.intent === 'none' || value.intent === 'identity') {
    return { intent: value.intent, confirmation: '' };
  }
  return { intent: value.intent, confirmation };
}

export function createOptOutReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): OptOutReader {
  return {
    async read(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
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
        // With no keyword list behind it, a failed read is a stop nobody saw. Urgent,
        // so a person reads the turn (#868); the text itself is never logged.
        console.error(
          { urgent: true, err: err instanceof Error ? err.name : 'unknown' },
          'URGENT: opt-out reader failed - a stop may be unread, page #ops now',
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
  const read = readTextOnce(reader, input);
  turnReads.set(turn, read);
  return read;
}

/** Seams that see only the words (the friend voice, its judge) share the turn's read
 * by text for a minute, so one inbound is still one model call (#868). */
const textReads = new Map<string, { at: number; read: Promise<OptOutReading | null> }>();
const TEXT_READ_TTL_MS = 60_000;

export function readTextOnce(
  reader: OptOutReader | null | undefined,
  input: { text: string; language: ReplyLanguage | null },
): Promise<OptOutReading | null> {
  if (!reader || input.text.trim().length === 0) return Promise.resolve(null);
  const now = Date.now();
  for (const [key, entry] of textReads) {
    if (now - entry.at > TEXT_READ_TTL_MS) textReads.delete(key);
  }
  const key = input.text;
  const hit = textReads.get(key);
  if (hit) return hit.read;
  const read = reader.read(input);
  textReads.set(key, { at: now, read });
  return read;
}

/** The model read this turn as "who is texting me / is this real" (#868: no regex). */
export function isIdentityReading(reading: OptOutReading | null): boolean {
  return reading?.intent === 'identity';
}

export function isCrisisReading(
  reading: OptOutReading | null,
): reading is OptOutReading & { intent: 'crisis_emergency' | 'crisis_mental' } {
  return reading?.intent === 'crisis_emergency' || reading?.intent === 'crisis_mental';
}

/**
 * #868 · the one reader every surface shares when it was not handed its own: the intake
 * machine, the email doors, the Linq group door, the roster. keywords.ts is gone, so
 * "is this a stop or a start" is always this model read, cached per text by
 * {@link readTextOnce} so the router, intake and a door cost one call between them.
 */
let shared: OptOutReader | null = null;

export function sharedOptOutReader(): OptOutReader {
  shared ??= createOptOutReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/** Tests install a scripted reader here; null restores the real one. */
export function setSharedOptOutReader(reader: OptOutReader | null): void {
  shared = reader;
}

/** 'stop' / 'start' when the model read that, else null (a failed read is null). */
export async function optOutIntentOf(
  text: string,
  reader: OptOutReader | null = null,
): Promise<'stop' | 'start' | null> {
  const reading = await readTextOnce(reader ?? sharedOptOutReader(), { text, language: null });
  return reading?.intent === 'stop' || reading?.intent === 'start' ? reading.intent : null;
}
