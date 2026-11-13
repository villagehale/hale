import { type AgentClient, forceToolJson, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
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
 * winter, is `nothing_stated`. The coach still replies.
 *
 * A missing client, a missing skill, or a model failure is the same outcome, and the log
 * names which. The parent's text is never in that line (rule #1, rule #11).
 */

export const SCHOOL_BREAK_REPLY_SKILL = 'school-break-reply';
export const SCHOOL_BREAK_REPLY_TOOL = 'school_break_reply';
export const SCHOOL_BREAK_REPLY_DESCRIPTION = 'Read the winter break days this parent gave.';
export const SCHOOL_BREAK_REPLY_MAX_TOKENS = 300;
const MAX_TEXT_CHARS = 1600;

export const SCHOOL_BREAK_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    quote: {
      type: ['string', 'null'],
      description: "The parent's words that give the days, copied exactly.",
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
    name: {
      type: ['string', 'null'],
      description: "What the break is called, in the parent's words or language.",
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: [
    'quote',
    'first_day',
    'first_day_text',
    'last_day',
    'last_day_text',
    'name',
    'confidence',
  ],
} as const;

export const schoolBreakReplyParse = z.object({
  quote: z.string().nullable(),
  first_day: z.string().nullable(),
  first_day_text: z.string().nullable(),
  last_day: z.string().nullable(),
  last_day_text: z.string().nullable(),
  name: z.string().nullable(),
  confidence: z.string(),
});

export type SchoolBreakReplyExtraction = z.infer<typeof schoolBreakReplyParse>;

/** The user message: the parent's words, today and the school year. Nothing else. */
export function schoolBreakReplyUserMessage(
  text: string,
  today: string,
  schoolYear: string,
): string {
  return JSON.stringify({ text: text.slice(0, MAX_TEXT_CHARS), today, school_year: schoolYear });
}

export type SchoolBreakReplyReading =
  | { status: 'read'; firstDay: string; lastDay: string; name: string; quote: string }
  | { status: 'nothing_stated' };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A reading safe to file, checked by code: pure, so the eval runs the same check. */
export function toSchoolBreakReplyReading(
  raw: SchoolBreakReplyExtraction,
  text: string,
  schoolYear: string,
): SchoolBreakReplyReading {
  if (raw.confidence !== 'high') return { status: 'nothing_stated' };
  const { quote, first_day: firstDay, last_day: lastDay } = raw;
  if (quote === null || firstDay === null || lastDay === null) return { status: 'nothing_stated' };
  if (!ISO_DAY.test(firstDay) || !ISO_DAY.test(lastDay)) return { status: 'nothing_stated' };
  const said = normalizeQuote(quote);
  if (said === '' || !normalizeQuote(text).includes(said)) return { status: 'nothing_stated' };
  // Each day is printed in the parent's own words and states exactly that day, read by
  // the same date grammar the board pages are held to: "around christmas" states no day.
  for (const [date, span] of [
    [firstDay, raw.first_day_text],
    [lastDay, raw.last_day_text],
  ] as const) {
    if (span === null || span.trim() === '' || !said.includes(normalizeQuote(span))) {
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
  const name = usableBreakName(raw.name);
  if (name === null) return { status: 'nothing_stated' };
  return { status: 'read', firstDay, lastDay, name, quote: quote.trim() };
}

export interface SchoolBreakReplyReader {
  read(input: {
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
    async read({ text, today, schoolYear }) {
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
          userMessage: schoolBreakReplyUserMessage(text, today, schoolYear),
          toolName: SCHOOL_BREAK_REPLY_TOOL,
          toolDescription: SCHOOL_BREAK_REPLY_DESCRIPTION,
          inputJsonSchema: SCHOOL_BREAK_REPLY_SCHEMA,
          schema: schoolBreakReplyParse,
          maxTokens: SCHOOL_BREAK_REPLY_MAX_TOKENS,
        });
        return toSchoolBreakReplyReading(value, text, schoolYear);
      } catch (err) {
        return nothing('model_failed', failure(err));
      }
    },
  };
}
