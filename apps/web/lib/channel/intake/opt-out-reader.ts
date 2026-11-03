import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import {
  CRISIS_SITUATIONS,
  type CrisisRegion,
  type CrisisSituation,
  crisisFactsForRegion,
} from '~/lib/channel/crisis-resources';
import {
  type ReplyLanguage,
  acceptReplyLanguage,
  certainLanguageHint,
} from '~/lib/channel/language';
import { linqGroupLeaveEnabled } from '~/lib/channel/linq/config';
import { readerConfirmationViolation } from '~/lib/channel/voice/said-line';
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
 * mental-health crisis in any wording comes back as `crisis_*`. The reader only
 * classifies a crisis; its text is never sent. The said-line writer answers from facts
 * (deliverCrisisReply). One call per inbound covers both, and {@link readTurnOnce}
 * shares it across every seam that asks within one turn.
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

/** What a seam that only routes may see: no reply text, so it cannot send one. */
export interface OptOutIntentReading {
  intent: OptOutIntent;
}

export interface OptOutReading extends OptOutIntentReading {
  /** Model-written stop/start confirmation. Empty for every other reading, crisis included. */
  confirmation: string;
  /** The language the text is written in, as the reader read it. Absent or null: it named none. */
  language?: ReplyLanguage | null;
  /** What the reader read happening, on a crisis reading only. Absent: not a crisis. */
  situation?: CrisisSituation;
}

export interface OptOutReadInput {
  text: string;
  language: ReplyLanguage | null;
  /**
   * Canada or the US when Hale already knows it. Never inferred from the
   * language of the text. The reader is handed that region's crisis lines as facts.
   */
  region?: CrisisRegion | null;
}

export interface OptOutReader {
  /** Null: the read failed (after its retry). */
  read(input: OptOutReadInput): Promise<OptOutReading | null>;
}

const SITUATIONS = [...CRISIS_SITUATIONS, 'none'] as const;

// `situation` is a plain optional string here, not an enum: an unknown or missing value
// must not fail the read (that would drop a stop or a crisis), so code validates it.
const outputSchema = z.object({
  intent: z.enum(INTENTS),
  verbatim: z.string(),
  language: z.string(),
  situation: z.string().optional(),
  confirmation: z.string(),
});

const outputJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    verbatim: { type: 'string' },
    language: { type: 'string' },
    situation: { type: 'string', enum: [...SITUATIONS] },
    confirmation: { type: 'string' },
  },
  required: ['intent', 'verbatim', 'language', 'situation', 'confirmation'],
} as const;

/** The user-turn payload. Shared with the evals, which replay this request shape. */
export function optOutUserMessage(input: OptOutReadInput): string {
  // A hint only when certain; the sender's words decide the reply's language (#868).
  // The reader has not classified yet, so every turn gets the mental facts:
  // the 988 line for a known region, or both 988 lines, plus 911. It never writes
  // them: the crisis writer is handed its own facts once the intent is known.
  return JSON.stringify({
    text: input.text,
    languageHint: certainLanguageHint(input.language),
    facts: crisisFactsForRegion(input.region, 'mental'),
  });
}

function situationFallbackReason(value: string | undefined): string {
  if (value === undefined) return 'situation_missing';
  return value === 'none' ? 'situation_none_on_crisis' : 'situation_unknown';
}

function crisisSituation(value: string | undefined): CrisisSituation {
  const listed = CRISIS_SITUATIONS.find((situation) => situation === value);
  if (listed) return listed;
  console.warn(
    { reason: situationFallbackReason(value) },
    'opt-out reader: crisis situation not in the list - the writer gets other',
  );
  return 'other';
}

/**
 * The reader wrote the confirmation while reading the parent's raw words. Its job is to
 * say stop or start, so a number or link in it is not sent; the stop or start itself
 * still runs.
 */
function acceptConfirmation(intent: 'stop' | 'start', text: string): string {
  const confirmation = text.trim();
  const violation = readerConfirmationViolation(confirmation);
  if (violation === null) return confirmation;
  console.error(
    { intent, reason: violation },
    'opt-out reader: confirmation carried a number or link - not sent',
  );
  return '';
}

/** Structural checks only: echo must match. Only a stop or a start keeps the reader's
 * text; a crisis reading keeps its routing and drops the text, which is never sent. */
export function acceptOptOutReading(
  value: z.infer<typeof outputSchema>,
  text: string,
): OptOutReading | null {
  if (value.verbatim !== text) return null;
  const language = acceptReplyLanguage(value.language);
  // VIL-477: "Hale, leave this group" is its own reading only while Hale can leave
  // (LINQ_GROUP_LEAVE_ENABLED). Dark, it stays the stop it always was, so the dark
  // path is unchanged; lit, it is not a stop and the group turn handles the leave.
  if (value.intent === 'leave_group') {
    return linqGroupLeaveEnabled()
      ? { intent: 'leave_group', confirmation: '', language }
      : { intent: 'stop', confirmation: acceptConfirmation('stop', value.confirmation), language };
  }
  if (value.intent === 'stop' || value.intent === 'start') {
    return {
      intent: value.intent,
      confirmation: acceptConfirmation(value.intent, value.confirmation),
      language,
    };
  }
  if (value.intent === 'crisis_emergency' || value.intent === 'crisis_mental') {
    return {
      intent: value.intent,
      confirmation: '',
      language,
      situation: crisisSituation(value.situation),
    };
  }
  return { intent: value.intent, confirmation: '', language };
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
  read: async () => ({ intent: 'none', confirmation: '', language: null }),
};

const turnReads = new WeakMap<object, Promise<OptOutReading | null>>();

/**
 * One read per inbound, however many seams ask. Keyed by the inbound object, so a
 * new turn always reads afresh and nothing outlives the turn.
 */
export function readTurnOnce(
  reader: OptOutReader | null | undefined,
  turn: object,
  input: OptOutReadInput,
): Promise<OptOutReading | null> {
  if (!reader || input.text.trim().length === 0) return Promise.resolve(null);
  const cached = turnReads.get(turn);
  if (cached) return cached;
  const read = readReplyOnce(reader, input);
  turnReads.set(turn, read);
  return read;
}

/** Reads shared by text for a minute, so one inbound is still one model call (#868). */
const textReads = new Map<
  string,
  { at: number; text: string; read: Promise<OptOutReading | null> }
>();
const TEXT_READ_TTL_MS = 60_000;
/** A memory bound, not a send rule: past it the oldest read is dropped and read again if asked. */
export const TEXT_READ_MAX_ENTRIES = 500;

function liveTextReads(): typeof textReads {
  const now = Date.now();
  for (const [key, entry] of textReads) {
    if (now - entry.at > TEXT_READ_TTL_MS) textReads.delete(key);
  }
  return textReads;
}

function rememberTextRead(
  key: string,
  entry: { at: number; text: string; read: Promise<OptOutReading | null> },
): void {
  // A Map iterates in insertion order, so the first key is the oldest read.
  while (textReads.size >= TEXT_READ_MAX_ENTRIES) {
    const oldest = textReads.keys().next().value as string;
    textReads.delete(oldest);
  }
  textReads.set(key, entry);
}

/**
 * The read whose stop/start confirmation may be sent. Keyed on the text, the language
 * and the region, with no fallback, so a confirmation never crosses a language or a
 * region. An explicit null region is its own key, distinct from a missing one.
 */
export function readReplyOnce(
  reader: OptOutReader | null | undefined,
  input: OptOutReadInput,
): Promise<OptOutReading | null> {
  if (!reader || input.text.trim().length === 0) return Promise.resolve(null);
  const key = JSON.stringify([
    input.text,
    input.language,
    input.region === undefined ? 'region-unset' : input.region,
  ]);
  const hit = liveTextReads().get(key);
  if (hit) return hit.read;
  const read = reader.read(input);
  rememberTextRead(key, { at: Date.now(), text: input.text, read });
  // A failed read is not remembered: the next ask reads again.
  void read.then((reading) => {
    if (reading === null && textReads.get(key)?.read === read) textReads.delete(key);
  });
  return read;
}

/**
 * The intent alone, for seams that only route (the identity check, the friend voice,
 * the Linq doors). Shared by text: any live read of the same words answers it, since
 * neither the language nor the region changes the intent. Its type carries no
 * confirmation, so no caller can send one.
 */
export async function readIntentOnce(
  reader: OptOutReader | null | undefined,
  input: Pick<OptOutReadInput, 'text' | 'language'>,
): Promise<OptOutIntentReading | null> {
  if (!reader || input.text.trim().length === 0) return null;
  const live = [...liveTextReads().values()].find((entry) => entry.text === input.text);
  const reading = await (live?.read ?? readReplyOnce(reader, input));
  return reading ? { intent: reading.intent } : null;
}

/** The old name of {@link readIntentOnce}; router/route.ts (#1006's lane) still imports it. */
export const readTextOnce = readIntentOnce;

/** The model read this turn as "who is texting me / is this real" (#868: no regex). */
export function isIdentityReading(reading: OptOutIntentReading | null): boolean {
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
 * {@link readIntentOnce} so the router, intake and a door cost one call between them.
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
  const reading = await readIntentOnce(reader ?? sharedOptOutReader(), { text, language: null });
  return reading?.intent === 'stop' || reading?.intent === 'start' ? reading.intent : null;
}

/** The reader's request shape, imported by the opt-out-read and crisis-reply evals. */
export const OPT_OUT_READ_TOOL_SCHEMA = outputJsonSchema;
export const OPT_OUT_READ_MAX_TOKENS = MAX_TOKENS;
