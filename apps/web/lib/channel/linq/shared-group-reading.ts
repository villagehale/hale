import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { isEnabled } from '@hale/flags';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { linqGroupCommonTimeEnabled } from './config';

/**
 * VIL-456 — read one turn in a multi-family group.
 *
 * The model returns one object. Code accepts it only when it matches the enums
 * below. A word list never overrides that reading. A failed call: one retry,
 * then `unclear`, and Hale does not change state.
 */

/**
 * Intents the recorded shared-group-reading skill (and its cached eval) asks for.
 * Byte-stable: adding a value here re-keys that eval.
 */
export const SHARED_GROUP_RECORDED_INTENTS = [
  'who_i_am',
  'join',
  'leave',
  'stop_me',
  'find_time',
  'pick_time',
  'question',
  'yes',
  'no',
  'chatter',
  'unclear',
] as const;

export const SHARED_GROUP_INTENTS = [
  'who_i_am',
  'join',
  'leave',
  'stop_me',
  'withdraw_calendar',
  'find_time',
  'pick_time',
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
  /** The speaker's clock, so `ruledOut` can be placed. Absent when no zone is known. */
  clock?: { now: string; timeZone: string };
  /**
   * VIL-459: the times Hale last offered in this chat, still ahead. A pick is one of
   * these or nothing. `local` is the speaker's wall clock, null when no zone is known.
   */
  offered?: readonly { start: string; local: string | null }[];
}

export interface RuledOutSpan {
  start: Date;
  end: Date;
}

export interface SharedGroupReading {
  intent: SharedGroupIntent;
  role: SharedGroupRole;
  familyLabel: string | null;
  /** The first of `kidNames`, for the line that confirms who someone is. */
  kidName: string | null;
  /**
   * VIL-687: every child this person said in this message they are family of, one per
   * entry ("Mia and Leo", "Mia, Leo", "Mia y Leo" are two). Hidden gifts for each of them
   * stop being shown to this person. A reading built without it holds only `kidName`.
   */
  kidNames?: readonly string[];
  /**
   * VIL-687: what the model's object said about whose family this person is, on any intent
   * and at any confidence, kept even when the rest of the reading is downgraded to unclear.
   * Read it through familyClaimOf.
   */
  familyClaim?: FamilyClaim | null;
  confidence: SharedGroupConfidence;
  /** VIL-459: on `find_time`, the times the chat said do not work. Empty otherwise. */
  ruledOut?: readonly RuledOutSpan[];
  /** VIL-459: on `pick_time`, the offered time they chose. Null otherwise. */
  picked?: Date | null;
  /** VIL-459: on `find_time` / `pick_time`, a short calendar title in their words. */
  planTitle?: string | null;
}

export interface SharedGroupReader {
  read(input: SharedGroupReadInput): Promise<SharedGroupReading>;
}

const readingSchema = z
  .object({
    intent: z.enum(SHARED_GROUP_INTENTS),
    role: z.enum(SHARED_GROUP_ROLES),
    familyLabel: z.string().nullable(),
    kidNames: z.array(z.string()),
    confidence: z.enum(['high', 'low']),
    ruledOut: z.array(z.object({ start: z.string(), end: z.string() }).strict()).optional(),
    picked: z.string().nullable().optional(),
    planTitle: z.string().nullable().optional(),
  })
  .strict();

function readingJsonSchema(intents: readonly string[]) {
  return {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      intent: { type: 'string', enum: [...intents] },
      role: { type: 'string', enum: [...SHARED_GROUP_ROLES] },
      familyLabel: { type: ['string', 'null'] },
      kidNames: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string', enum: ['high', 'low'] },
      ruledOut: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { start: { type: 'string' }, end: { type: 'string' } },
          required: ['start', 'end'],
        },
      },
      picked: { type: ['string', 'null'] },
      planTitle: { type: ['string', 'null'] },
    },
    required: [
      'intent',
      'role',
      'familyLabel',
      'kidNames',
      'confidence',
      'ruledOut',
      'picked',
      'planTitle',
    ],
  };
}

/** Request shape of the recorded shared-group-reading skill. Do not add enum values. */
export const sharedGroupReadingJsonSchema = readingJsonSchema(SHARED_GROUP_RECORDED_INTENTS);

/** VIL-643: common-time reader, which also returns `withdraw_calendar`. */
export const sharedGroupReadingCommonTimeJsonSchema = readingJsonSchema(SHARED_GROUP_INTENTS);

const UNCLEAR: SharedGroupReading = {
  intent: 'unclear',
  role: 'unclear',
  familyLabel: null,
  kidName: null,
  kidNames: [],
  familyClaim: null,
  confidence: 'low',
  ruledOut: [],
  picked: null,
  planTitle: null,
};

const STATE_CHANGE: ReadonlySet<SharedGroupIntent> = new Set([
  'who_i_am',
  'join',
  'leave',
  'stop_me',
  'withdraw_calendar',
  'pick_time',
]);

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function sharedGroupUserMessage(input: SharedGroupReadInput): string {
  return JSON.stringify({
    text: input.text,
    reaction: input.reaction,
    language: input.language,
    people: input.people,
    recent: input.recent.slice(-6),
    ...(input.clock ? { clock: input.clock } : {}),
    ...(input.offered?.length ? { offered: input.offered } : {}),
  });
}

function spansOf(raw: readonly { start: string; end: string }[] | undefined): RuledOutSpan[] {
  const spans: RuledOutSpan[] = [];
  for (const span of raw ?? []) {
    const start = new Date(span.start);
    const end = new Date(span.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (end.getTime() <= start.getTime()) continue;
    spans.push({ start, end });
  }
  return spans;
}

/** At most this many children in one reading, each at most KID_NAME_MAX characters. */
const KID_NAMES_MAX = 10;
const KID_NAME_MAX = 100;

/** The children a reading names, trimmed, without blanks or repeats. */
export function kidNamesOf(reading: Pick<SharedGroupReading, 'kidName' | 'kidNames'>): string[] {
  const names = reading.kidNames ?? (reading.kidName ? [reading.kidName] : []);
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
}

/**
 * Someone saying whose family they are: the children they named, or `unnamed` when they
 * gave a family role without a child, or named children Hale cannot take as stated (past
 * the bounds, or at low confidence), so the claim could be about any child.
 */
export type FamilyClaim = { kids: readonly string[] } | 'unnamed';

/** Every role but these says the person is a child's family (a nanny included). */
const NOT_FAMILY_ROLES: ReadonlySet<SharedGroupRole> = new Set(['guest', 'unclear']);

function claimFrom(
  role: SharedGroupRole,
  kids: readonly string[],
  confidence: SharedGroupConfidence,
): FamilyClaim | null {
  if (kids.length > 0) {
    const stated =
      confidence === 'high' &&
      kids.length <= KID_NAMES_MAX &&
      kids.every((name) => name.length <= KID_NAME_MAX);
    return stated ? { kids } : 'unnamed';
  }
  return NOT_FAMILY_ROLES.has(role) ? null : 'unnamed';
}

/**
 * VIL-687: whose family a reading says this person is, whatever the intent. A reading built
 * without `familyClaim` (not from the model's object) is read from its role and children.
 */
export function familyClaimOf(reading: SharedGroupReading): FamilyClaim | null {
  if (reading.familyClaim !== undefined) return reading.familyClaim;
  return claimFrom(reading.role, kidNamesOf(reading), reading.confidence);
}

function blankToNull(value: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const PLAN_TITLE_MAX = 80;

/** The offered start the model named, matched to the instant. Null when it named none of them. */
function offeredPick(raw: string | null | undefined, offered: readonly string[]): Date | null {
  if (!raw) return null;
  const at = new Date(raw).getTime();
  if (Number.isNaN(at)) return null;
  const match = offered.find((start) => new Date(start).getTime() === at);
  return match ? new Date(match) : null;
}

/**
 * Validate a model object. Anything outside the contract is `unclear`. A pick counts only
 * as one of `offered` (the starts Hale showed the reader), so the model can never place
 * a time Hale did not propose.
 */
export function parseSharedGroupReading(
  value: unknown,
  offered: readonly string[] = [],
): SharedGroupReading {
  const parsed = readingSchema.safeParse(value);
  if (!parsed.success) return UNCLEAR;
  const { intent, role, familyLabel, kidNames, confidence, ruledOut, picked, planTitle } =
    parsed.data;
  const kids = kidNamesOf({ kidName: null, kidNames });
  // A claim is kept whatever happens to the rest of the reading.
  const familyClaim = claimFrom(role, kids, confidence);
  const unclear = { ...UNCLEAR, familyClaim };
  if (kids.length > KID_NAMES_MAX || kids.some((name) => name.length > KID_NAME_MAX)) {
    return unclear;
  }
  if (STATE_CHANGE.has(intent) && confidence !== 'high') return unclear;
  if (intent === 'unclear') return unclear;
  const pick = intent === 'pick_time' ? offeredPick(picked, offered) : null;
  if (intent === 'pick_time' && !pick) return unclear;
  const title =
    intent === 'find_time' || intent === 'pick_time' ? blankToNull(planTitle ?? null) : null;
  return {
    intent,
    role,
    familyLabel: blankToNull(familyLabel),
    kidName: kids[0] ?? null,
    kidNames: kids,
    familyClaim,
    confidence,
    ruledOut: intent === 'find_time' ? spansOf(ruledOut) : [],
    picked: pick,
    planTitle: title && title.length <= PLAN_TITLE_MAX ? title : null,
  };
}

/** Room for a find-time reading's spans ("after 5 on weekdays" is five of them). */
export const SHARED_GROUP_READ_MAX_TOKENS = 400;

export function createSharedGroupReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): SharedGroupReader {
  const once = async (input: SharedGroupReadInput): Promise<SharedGroupReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    // VIL-643: while common time is dark, the live reader stays the recorded
    // shared-group-reading skill and schema (cached evals keep hitting). Once
    // the flag is on, the common-time skill also reads a calendar-only withdrawal.
    const commonTime = linqGroupCommonTimeEnabled();
    const skill = await loadCronSkill(
      commonTime ? 'shared-group-reading-common-time' : 'shared-group-reading',
    );
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: sharedGroupUserMessage(input),
      toolName: 'record_shared_group_reading',
      toolDescription: 'What this person meant in the shared group.',
      inputJsonSchema: commonTime
        ? sharedGroupReadingCommonTimeJsonSchema
        : sharedGroupReadingJsonSchema,
      schema: readingSchema,
      maxTokens: SHARED_GROUP_READ_MAX_TOKENS,
    });
    return parseSharedGroupReading(
      value,
      (input.offered ?? []).map((slot) => slot.start),
    );
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
  if (!process.env.ANTHROPIC_API_KEY || !isEnabled('voice')) return null;
  shared ??= createSharedGroupReader(() =>
    budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' }),
  );
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
