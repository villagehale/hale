import { type AgentClient, forceToolJson, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { addDaysToKey } from '~/lib/plan/spine';
import { dateSpanRefusal, normalizeQuote } from '~/lib/registration/verify-window';
import { isWinterBreak } from './cycle';
import { usableBreakName } from './read';

/**
 * VIL-685 · WHAT A PARENT SAID WHEN HALE ASKED ABOUT THEIR WINTER BREAK.
 *
 * A model reads the reply. There is no word list over the parent's words. The cost of a
 * wrong read is a break Hale later names as fact, so anything short of a high-confidence
 * reading of both days, quoted from the parent's own words, each day printed there and
 * stating exactly that day (the board pages' date grammar), inside this school year's
 * winter, is `nothing_stated`. The coach still replies. The reader is given the question
 * Hale asked, as sent, so a bare range ("Dec 19 - Jan 5") answering "when are the kids
 * back?" ends on the day back, not the last day off: that day is read as said, and the
 * last day off is the day before it, by calendar arithmetic. When the question put days
 * to the parent (the school's email stated them) and the parent confirmed them, the days
 * are read off the question as sent, held to the same checks against its words. The
 * break's name is the parent's own when they gave one, and null when they did not: none
 * is made up, and none is taken from the question.
 *
 * A missing client, a missing skill, or a model failure is the same outcome, and the log
 * names which. The parent's text is never in that line (rule #1, rule #11).
 */

export const SCHOOL_BREAK_REPLY_SKILL = 'school-break-reply';
export const SCHOOL_BREAK_REPLY_TOOL = 'school_break_reply';
export const SCHOOL_BREAK_REPLY_DESCRIPTION = 'Read the winter break days this parent gave.';
export const SCHOOL_BREAK_REPLY_MAX_TOKENS = 1024;
const MAX_TEXT_CHARS = 1600;

export const SCHOOL_BREAK_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days_from: {
      type: ['string', 'null'],
      enum: ['reply', 'question', null],
      description:
        "`reply` when the days are in the parent's words, `question` when the parent confirmed the days the question gave.",
    },
    quote: {
      type: ['string', 'null'],
      description: 'The words that give the days, copied exactly from where `days_from` says.',
    },
    first_day: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    first_day_text: {
      type: ['string', 'null'],
      description: 'The characters of `quote` that state the first day, copied exactly.',
    },
    last_day: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    last_day_text: {
      type: ['string', 'null'],
      description: 'The characters of `quote` that state the last day, copied exactly.',
    },
    back_day: {
      type: ['string', 'null'],
      description: 'YYYY-MM-DD, the first day back, when that is what the days give instead.',
    },
    back_day_text: {
      type: ['string', 'null'],
      description: 'The characters of `quote` that state the day back, copied exactly.',
    },
    name: {
      type: ['string', 'null'],
      description:
        'What the parent called the break, in their own words, or null when they named it nothing.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'days_from',
    'quote',
    'first_day',
    'first_day_text',
    'last_day',
    'last_day_text',
    'back_day',
    'back_day_text',
    'name',
    'confidence',
  ],
} as const;

export const schoolBreakReplyParse = z.object({
  days_from: z.enum(['reply', 'question']).nullable(),
  quote: z.string().nullable(),
  first_day: z.string().nullable(),
  first_day_text: z.string().nullable(),
  last_day: z.string().nullable(),
  last_day_text: z.string().nullable(),
  back_day: z.string().nullable(),
  back_day_text: z.string().nullable(),
  name: z.string().nullable(),
  confidence: z.string(),
});

export type SchoolBreakReplyExtraction = z.infer<typeof schoolBreakReplyParse>;

/** The user message: the question Hale asked as sent, the parent's words, today and the
 * school year. Nothing else. */
export function schoolBreakReplyUserMessage(input: {
  question: string | null;
  text: string;
  today: string;
  schoolYear: string;
}): string {
  return JSON.stringify({
    question: input.question === null ? null : input.question.slice(0, MAX_TEXT_CHARS),
    text: input.text.slice(0, MAX_TEXT_CHARS),
    today: input.today,
    school_year: input.schoolYear,
  });
}

export type SchoolBreakReplyReading =
  | { status: 'read'; firstDay: string; lastDay: string; name: string | null; quote: string }
  | { status: 'nothing_stated' };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A reading safe to file, checked by code: pure, so the eval runs the same check. */
export function toSchoolBreakReplyReading(
  raw: SchoolBreakReplyExtraction,
  said: { text: string; question: string | null },
  schoolYear: string,
): SchoolBreakReplyReading {
  if (raw.confidence !== 'high') return { status: 'nothing_stated' };
  const { text } = said;
  // The words the days must be printed in: the parent's, or the question they confirmed.
  const source =
    raw.days_from === 'reply' ? text : raw.days_from === 'question' ? said.question : null;
  if (source === null) return { status: 'nothing_stated' };
  const { quote, first_day: firstDay } = raw;
  // The break's end, as the parent gave it: the last day off, or the day back. One of them.
  const end =
    raw.last_day !== null && raw.back_day === null
      ? { date: raw.last_day, text: raw.last_day_text }
      : raw.back_day !== null && raw.last_day === null
        ? { date: raw.back_day, text: raw.back_day_text }
        : null;
  if (quote === null || firstDay === null || end === null) return { status: 'nothing_stated' };
  if (!ISO_DAY.test(firstDay) || !ISO_DAY.test(end.date)) return { status: 'nothing_stated' };
  const lastDay = raw.back_day === null ? end.date : addDaysToKey(end.date, -1);
  const quoted = normalizeQuote(quote);
  if (quoted === '' || !normalizeQuote(source).includes(quoted))
    return { status: 'nothing_stated' };
  // Each day is printed in those words and states exactly that day, read by the same date
  // grammar the board pages are held to: "around christmas" states no day.
  for (const [date, span] of [
    [firstDay, raw.first_day_text],
    [end.date, end.text],
  ] as const) {
    if (span === null || span.trim() === '' || !quoted.includes(normalizeQuote(span))) {
      return { status: 'nothing_stated' };
    }
    const refusal = dateSpanRefusal({
      quote: span,
      dateText: span,
      timeText: null,
      date,
      time: null,
    });
    if (refusal !== null) return { status: 'nothing_stated' };
  }
  if (!isWinterBreak(schoolYear, firstDay, lastDay)) return { status: 'nothing_stated' };
  // A name the parent did not write is not theirs: it is dropped, never filed.
  const name = usableBreakName(raw.name);
  const named = name !== null && normalizeQuote(text).includes(normalizeQuote(name));
  return { status: 'read', firstDay, lastDay, name: named ? name : null, quote: quote.trim() };
}

export interface SchoolBreakReplyReader {
  read(input: {
    /** The question Hale asked, as sent; null when the ledger holds no text for it. */
    question: string | null;
    text: string;
    today: string;
    schoolYear: string;
  }): Promise<SchoolBreakReplyReading>;
}

function failure(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function nothing(reason: string, detail?: string): SchoolBreakReplyReading {
  console.info({ reason, detail }, 'school break reply: nothing stated');
  return { status: 'nothing_stated' };
}

/** `client` is a resolver: these deps are built for every inbound text, so a missing key
 * must not throw. It is `nothing_stated`, named in the log. */
export function createSchoolBreakReplyReader(client: () => AgentClient): SchoolBreakReplyReader {
  return {
    async read(input) {
      const { text, schoolYear } = input;
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return nothing('client_unavailable', failure(err));
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SCHOOL_BREAK_REPLY_SKILL);
      } catch (err) {
        return nothing('skill_unavailable', failure(err));
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: schoolBreakReplyUserMessage(input),
          toolName: SCHOOL_BREAK_REPLY_TOOL,
          toolDescription: SCHOOL_BREAK_REPLY_DESCRIPTION,
          inputJsonSchema: SCHOOL_BREAK_REPLY_SCHEMA,
          schema: schoolBreakReplyParse,
          maxTokens: SCHOOL_BREAK_REPLY_MAX_TOKENS,
        });
        return toSchoolBreakReplyReading(value, { text, question: input.question }, schoolYear);
      } catch (err) {
        return nothing('model_failed', failure(err));
      }
    },
  };
}
