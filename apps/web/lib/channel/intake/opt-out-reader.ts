import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { linqGroupLeaveEnabled } from '~/lib/channel/linq/config';
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
  | 'leave_group'
  | 'none';

const INTENTS = [
  'stop',
  'start',
  'crisis_emergency',
  'crisis_mental',
  'identity',
  'leave_group',
  'none',
] as const;

export interface OptOutReading {
  intent: OptOutIntent;
  /** Model-written reply: the stop/start confirmation, or the crisis reply. Empty for none. */
  confirmation: string;
}

export interface OptOutReadInput {
  text: string;
  language: ReplyLanguage | null;
}

export interface OptOutReader {
  /** Null: the read failed (after its retry). */
  read(input: OptOutReadInput): Promise<OptOutReading | null>;
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
  // VIL-477: "Hale, leave this group" is its own reading only while Hale can leave
  // (LINQ_GROUP_LEAVE_ENABLED). Dark, it stays the stop it always was, so the dark
  // path is unchanged; lit, it is not a stop and the group turn handles the leave.
  if (value.intent === 'leave_group') {
    return linqGroupLeaveEnabled()
      ? { intent: 'leave_group', confirmation: '' }
      : { intent: 'stop', confirmation };
  }
  if (value.intent === 'none' || value.intent === 'identity') {
    return { intent: value.intent, confirmation: '' };
  }
  return { intent: value.intent, confirmation };
}

export function createOptOutReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): OptOutReader {
  const once = async (input: OptOutReadInput): Promise<OptOutReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
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
  };
  return {
    async read(input) {
      // #868: one retry. Two failures return null; the intake machine then holds the
      // sender (opt-out-hold.ts) and the urgent log below pages #ops.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.error(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'opt-out reader: read failed',
          );
        }
      }
      // With no keyword list behind it, a failed read is a stop nobody saw. Urgent,
      // so a person reads the turn; the text itself is never logged.
      console.error(
        { urgent: true },
        'URGENT: opt-out reader failed twice - a stop may be unread, page #ops now',
      );
      return null;
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
  // A failed read is not remembered: the next ask reads again.
  void read.then((reading) => {
    if (reading === null && textReads.get(key)?.read === read) textReads.delete(key);
  });
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
