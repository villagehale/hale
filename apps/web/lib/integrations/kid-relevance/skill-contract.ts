import { ageInMonths } from '@hale/types';
import { z } from 'zod';

/**
 * The kid-item-classifier skill's wire contract, shared by the connector judge, the
 * onboarding wow filter and the eval, so the three can never send different shapes.
 *
 * `reason` comes BEFORE `verdict` on purpose: a verdict emitted first is a verdict
 * reasoned backwards from.
 */
export const KID_VERDICT_TOOL = 'kid_verdicts';
export const KID_VERDICT_TOOL_DESCRIPTION =
  'Return one verdict per item: is it about the children, the parent, or unclear.';

/**
 * The output ceiling for one call. `max_tokens` caps thinking AND the answer together on
 * the classify lane, so it is sized from the eval's measured output, not guessed; the
 * judge derives its items-per-call from it (see judge.ts).
 */
export const KID_JUDGE_MAX_TOKENS = 4096;

/**
 * The output one item may cost, thinking included. The recorded eval peaked at 59 tokens
 * per item on the classify lane (2026-10-11); this is that with headroom for a batch that
 * thinks harder. The eval fails when a recorded batch spends more per item than this, so
 * the two numbers move together.
 */
export const KID_JUDGE_PEAK_TOKENS_PER_ITEM = 128;

/** Items per call: as many as fit under the ceiling at the measured peak. */
export const KID_JUDGE_ITEMS_PER_CALL = Math.floor(
  KID_JUDGE_MAX_TOKENS / KID_JUDGE_PEAK_TOKENS_PER_ITEM,
);

export const KID_VERDICTS = ['kid', 'adult', 'unsure'] as const;
export type KidVerdictValue = (typeof KID_VERDICTS)[number];

export const kidVerdictsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          reason: { type: 'string' },
          verdict: { type: 'string', enum: [...KID_VERDICTS] },
          childName: { type: ['string', 'null'] },
        },
        required: ['ref', 'reason', 'verdict', 'childName'],
      },
    },
  },
  required: ['verdicts'],
} as const;

export const kidVerdictsSchema = z
  .object({
    verdicts: z.array(
      z
        .object({
          ref: z.string(),
          reason: z.string(),
          verdict: z.enum(KID_VERDICTS),
          childName: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type KidVerdictsAnswer = z.infer<typeof kidVerdictsSchema>;

/** What the skill reads. `activityTitles` and `notMineHints` are optional. */
export interface KidSkillInput {
  children: readonly { name: string; ageMonths: number | null }[];
  activityTitles?: readonly string[];
  notMineHints?: readonly string[];
  items: readonly {
    ref: string;
    text: string;
    source?: 'google_calendar' | 'gmail' | 'group';
    startsAt?: string;
  }[];
}

/** The one serialisation every caller sends, so the cache key and the prompt agree. */
export function kidSkillMessage(input: KidSkillInput): string {
  return JSON.stringify(input);
}

export type KidRelevanceSource = 'google_calendar' | 'gmail' | 'group';

/** One thing Hale read from a connector, as the judge is handed it. */
export interface KidRelevanceItem {
  /** The caller's handle for this item; echoed back on its judgement. */
  ref: string;
  source: KidRelevanceSource;
  integrationId: string | null;
  /** gcal: recurringEventId ?? eventId; gmail: messageId; group: sha256(title). */
  itemKey: string;
  title: string;
  startsAt: string | null;
  place: string | null;
  sender: string | null;
}

export interface KidRelevanceChild {
  id: string;
  name: string;
  dateOfBirth: string;
}

/** The text the model reads for one item: its title, where, and who sent it. */
export function kidItemText(item: Pick<KidRelevanceItem, 'title' | 'place' | 'sender'>): string {
  return [
    item.title,
    item.place ? `at ${item.place}` : '',
    item.sender ? `from ${item.sender}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The skill input for one batch. Refs are batch positions, never the caller's ids, so
 * nothing about the row reaches the model and the request is the same for the same items.
 */
export function kidSkillInputFor(
  items: readonly Pick<KidRelevanceItem, 'source' | 'title' | 'startsAt' | 'place' | 'sender'>[],
  children: readonly Pick<KidRelevanceChild, 'name' | 'dateOfBirth'>[],
  notMineHints: readonly string[],
  now: Date,
): KidSkillInput {
  return {
    children: children.map((child) => ({
      name: child.name,
      ageMonths: ageInMonths(child.dateOfBirth, now),
    })),
    ...(notMineHints.length > 0 ? { notMineHints } : {}),
    items: items.map((item, index) => ({
      ref: `i${index}`,
      text: kidItemText(item),
      source: item.source,
      ...(item.startsAt ? { startsAt: item.startsAt } : {}),
    })),
  };
}
