import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-456 — read one turn in a multi-family group.
 *
 * The model returns one object. Code accepts it only when it matches the enums
 * below. A word list never overrides that reading. A failed call: one retry,
 * then `unclear`, and Hale does not change state.
 */

export const SHARED_GROUP_INTENTS = [
  'who_i_am',
  'join',
  'leave',
  'stop_me',
  'question',
  'yes',
  'no',
  'chatter',
  'unclear',
] as const;
export type SharedGroupIntent = (typeof SHARED_GROUP_INTENTS)[number];

export const SHARED_GROUP_ROLES = [
  'parent',
  'co_parent',
  'grandparent',
  'nanny',
  'caregiver',
  'other_family',
  'guest',
  'unclear',
] as const;
export type SharedGroupRole = (typeof SHARED_GROUP_ROLES)[number];

export type SharedGroupConfidence = 'high' | 'low';
export type SharedGroupReaction = 'yes' | 'no';

export interface SharedGroupPersonFact {
  firstName: string | null;
  knownCustomer: boolean;
  familyLinked: boolean;
}

export interface SharedGroupReadInput {
  text: string;
  reaction: SharedGroupReaction | null;
  language: string | null;
  people: readonly SharedGroupPersonFact[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface SharedGroupReading {
  intent: SharedGroupIntent;
  role: SharedGroupRole;
  familyLabel: string | null;
  kidName: string | null;
  confidence: SharedGroupConfidence;
}

export interface SharedGroupReader {
  read(input: SharedGroupReadInput): Promise<SharedGroupReading>;
}

const readingSchema = z
  .object({
    intent: z.enum(SHARED_GROUP_INTENTS),
    role: z.enum(SHARED_GROUP_ROLES),
    familyLabel: z.string().nullable(),
    kidName: z.string().nullable(),
    confidence: z.enum(['high', 'low']),
  })
  .strict();

export const sharedGroupReadingJsonSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...SHARED_GROUP_INTENTS] },
    role: { type: 'string', enum: [...SHARED_GROUP_ROLES] },
    familyLabel: { type: ['string', 'null'] },
    kidName: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['intent', 'role', 'familyLabel', 'kidName', 'confidence'],
};

const UNCLEAR: SharedGroupReading = {
  intent: 'unclear',
  role: 'unclear',
  familyLabel: null,
  kidName: null,
  confidence: 'low',
};

const STATE_CHANGE: ReadonlySet<SharedGroupIntent> = new Set([
  'who_i_am',
  'join',
  'leave',
  'stop_me',
]);

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function sharedGroupUserMessage(input: SharedGroupReadInput): string {
  return JSON.stringify({
    text: input.text,
    reaction: input.reaction,
    language: input.language,
    people: input.people,
    recent: input.recent.slice(-6),
  });
}

function blankToNull(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validate a model object. Anything outside the contract is `unclear`. */
export function parseSharedGroupReading(value: unknown): SharedGroupReading {
  const parsed = readingSchema.safeParse(value);
  if (!parsed.success) return UNCLEAR;
  const { intent, role, familyLabel, kidName, confidence } = parsed.data;
  if (STATE_CHANGE.has(intent) && confidence !== 'high') return UNCLEAR;
  if (intent === 'unclear') return UNCLEAR;
  return {
    intent,
    role,
    familyLabel: blankToNull(familyLabel),
    kidName: blankToNull(kidName),
    confidence,
  };
}

export function createSharedGroupReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): SharedGroupReader {
  const once = async (input: SharedGroupReadInput): Promise<SharedGroupReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('shared-group-reading');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: sharedGroupUserMessage(input),
      toolName: 'record_shared_group_reading',
      toolDescription: 'What this person meant in the shared group.',
      inputJsonSchema: sharedGroupReadingJsonSchema,
      schema: readingSchema,
      maxTokens: 200,
    });
    return parseSharedGroupReading(value);
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
            'shared group reader: read failed',
          );
        }
      }
      console.error({ outcome: 'shared_group_unread' }, 'shared group reader: no state change');
      return UNCLEAR;
    },
  };
}

let shared: SharedGroupReader | null = null;

export function sharedGroupReader(): SharedGroupReader | null {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return null;
  shared ??= createSharedGroupReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/** Linq tapbacks Hale can read as a yes or a no on Hale's own last line. */
export function reactionAsVote(
  reactionType: string | null | undefined,
): SharedGroupReaction | null {
  if (!reactionType) return null;
  const kind = reactionType.trim().toLowerCase();
  if (kind === 'like' || kind === 'love' || kind === 'emphasize') return 'yes';
  if (kind === 'dislike') return 'no';
  return null;
}
