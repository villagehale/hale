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
 * the screen lane (Haiku 5.5), so it is sized from the eval's measured output, not
 * guessed; the judge derives its items-per-call from it (see judge.ts).
 */
export const KID_JUDGE_MAX_TOKENS = 4096;

/**
 * The output one item may cost, thinking included. The recorded eval peaked at 120 tokens
 * per item on the screen lane (2026-10-12, the 9-item mailbox batch); this is that with
 * headroom for a batch that thinks harder. The eval fails when a recorded batch spends
 * more per item than this, so the two numbers move together.
 */
export const KID_JUDGE_PEAK_TOKENS_PER_ITEM = 128;

/** Items per call: as many as fit under the ceiling at the measured peak. */
export const KID_JUDGE_ITEMS_PER_CALL = Math.floor(
  KID_JUDGE_MAX_TOKENS / KID_JUDGE_PEAK_TOKENS_PER_ITEM,
);

/**
 * The longest reason stored for a kid verdict. The recorded eval's longest kid reason was
 * 109 characters (2026-10-12; its longest reason, 131, was an adult one, which is never
 * stored); a longer one is dropped at storage, never at the wire, so a verbose answer
 * still counts as a verdict.
 */
export const KID_REASON_MAX_CHARS = 120;

/** The longest not-mine hint kept: the kind of thing it was, in a few words. */
export const KID_HINT_MAX_CHARS = 48;

/**
 * Lowercased, unaccented words only, so "Wren Swim," and "wren swim" compare equal, and
 * so do "José" and "Jose". NFKC first folds width and compatibility forms.
 */
function foldWords(text: string): string {
  return text
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when `text` carries any of `own` as a whole run of words. */
export function repeatsAny(text: string, own: readonly (string | null)[]): boolean {
  const folded = ` ${foldWords(text)} `;
  return own.some((value) => {
    const words = value === null ? '' : foldWords(value);
    return words.length > 0 && folded.includes(` ${words} `);
  });
}

/** Below this, a lowercase Latin word of a place or sender ("at", "a") names nothing. */
const SHORTEST_NAMING_WORD = 3;

/**
 * Whether one word of a place or sender, as written, can name someone or somewhere: three
 * or more letters, a capitalized Latin word of two ("Li", "Wu"), or any word with a letter
 * outside the Latin script (a Chinese surname is one character). Digits never name.
 */
function namesSomething(word: string): boolean {
  const letters = [...word].filter((char) => /\p{L}/u.test(char));
  return (
    letters.length >= SHORTEST_NAMING_WORD ||
    (letters.length >= 2 && /^\p{Lu}/u.test(word)) ||
    letters.some((char) => !/\p{Script=Latin}/u.test(char))
  );
}

/** True when `text` carries any one naming word of any of `own`. */
export function sharesAnyWord(text: string, own: readonly (string | null)[]): boolean {
  const words = new Set(foldWords(text).split(' '));
  return own.some((value) =>
    value
      ?.normalize('NFKC')
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .some((word) => namesSomething(word) && words.has(foldWords(word))),
  );
}

/**
 * The reason as stored, unless it is empty, long, repeats the item's title, or carries any
 * naming word of its place or sender: a surname or a venue's first word alone still says
 * where or who. The judge stores this; the eval reports how many of its reasons survive it.
 */
export function storedReason(
  reason: string,
  item: Pick<KidRelevanceItem, 'title' | 'place' | 'sender'>,
): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > KID_REASON_MAX_CHARS) return null;
  return repeatsAny(trimmed, [item.title]) || sharesAnyWord(trimmed, [item.place, item.sender])
    ? null
    : trimmed;
}

export const KID_VERDICTS = ['kid', 'adult', 'unsure'] as const;
export type KidVerdictValue = (typeof KID_VERDICTS)[number];

/**
 * The verdict tool for one call. `childName` can only be one of the children the call
 * sends, or null, so a nickname or a misspelling fails validation (and is retried, then
 * held) instead of becoming a kid verdict with no child id - which the teen gate reads
 * (rule #1). A family with no children gets null only.
 */
export function kidVerdictsContract(childNames: readonly string[]) {
  const names = [...new Set(childNames)];
  const [first, ...rest] = names;
  const jsonSchema = {
    type: 'object' as const,
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
            childName:
              first === undefined
                ? { type: 'null' }
                : { type: ['string', 'null'], enum: [...names, null] },
          },
          required: ['ref', 'reason', 'verdict', 'childName'],
        },
      },
    },
    required: ['verdicts'],
  };
  const schema = z
    .object({
      verdicts: z.array(
        z
          .object({
            ref: z.string(),
            reason: z.string(),
            verdict: z.enum(KID_VERDICTS),
            childName: first === undefined ? z.null() : z.enum([first, ...rest]).nullable(),
          })
          .strict(),
      ),
    })
    .strict();
  return { jsonSchema, schema };
}

export interface KidVerdictsAnswer {
  verdicts: { ref: string; reason: string; verdict: KidVerdictValue; childName: string | null }[];
}

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
