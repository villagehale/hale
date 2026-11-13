import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, forceToolJson, pickLane } from '@hale/agent';
import { ZodError, z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { StructuredOutputError } from '~/lib/pipeline/structured';
import { MAX_PAGE_TEXT_CHARS } from '~/lib/registration/fetch';
import { normalizeQuote } from '~/lib/registration/verify-window';

/**
 * VIL-685 · DID A SCHOOL WRITE THIS EMAIL? Authentication (sender.ts) proves which domain
 * sent a message, not that the domain is a school: a coach, a camp, a vendor and a
 * daycare all send authenticated kid mail. A model reads the email's text and says who
 * wrote it, and code holds it to the email's own words: `school` stands only with the
 * words naming the school or board copied from the text. Anything else, a daycare
 * included, names no school (a daycare's closures come only from the parent's reply).
 */

export const SCHOOL_SENDER_SKILL = 'school-mail-sender';
export const SCHOOL_SENDER_TOOL = 'school_mail_sender';
export const SCHOOL_SENDER_DESCRIPTION = 'Say who wrote this email to the family.';
export const SCHOOL_SENDER_MAX_TOKENS = 400;

const LINE = 300;

export const SCHOOL_SENDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', maxLength: LINE },
    sender: { type: 'string', enum: ['school', 'daycare', 'other'] },
    school_words: {
      type: ['string', 'null'],
      maxLength: LINE,
      description: 'The email words naming the school or board, copied exactly.',
    },
  },
  required: ['reason', 'sender', 'school_words'],
} as const;

export const schoolSenderParse = z.object({
  reason: z.string(),
  sender: z.enum(['school', 'daycare', 'other']),
  school_words: z.string().nullable(),
});

export type SchoolSenderExtraction = z.infer<typeof schoolSenderParse>;

/** The user message: the authenticated domain and the email's text. Nothing about a family. */
export function schoolSenderInput(fromDomain: string, text: string): string {
  return JSON.stringify({ from_domain: fromDomain, text: text.slice(0, MAX_PAGE_TEXT_CHARS) });
}

export type SchoolSender =
  | { status: 'school' }
  | { status: 'not_school'; reason: 'daycare' | 'other' | 'unquoted' }
  | { status: 'unreadable'; reason: 'extract_failed' };

/** Pure, so the eval and the sweep run the same check. */
export function checkSchoolSender(extraction: SchoolSenderExtraction, text: string): SchoolSender {
  if (extraction.sender !== 'school') return { status: 'not_school', reason: extraction.sender };
  const words = extraction.school_words;
  const quoted =
    words !== null &&
    words.trim() !== '' &&
    normalizeQuote(text.slice(0, MAX_PAGE_TEXT_CHARS)).includes(normalizeQuote(words));
  return quoted ? { status: 'school' } : { status: 'not_school', reason: 'unquoted' };
}

export type SchoolSenderReader = (input: { host: string; text: string }) => Promise<SchoolSender>;

export function createSchoolSenderReader(
  extract: (fromDomain: string, text: string) => Promise<SchoolSenderExtraction>,
): SchoolSenderReader {
  return async ({ host, text }) => {
    let extraction: SchoolSenderExtraction;
    try {
      extraction = await extract(host, text);
    } catch (error) {
      if (
        error instanceof StructuredOutputError ||
        error instanceof Anthropic.APIError ||
        error instanceof ZodError
      ) {
        return { status: 'unreadable', reason: 'extract_failed' };
      }
      throw error;
    }
    return checkSchoolSender(extraction, text);
  };
}

/** The skill loads outside any catch: a missing skill is a deploy bug, never "not a school". */
export function createLiveSchoolSenderReader(client: AgentClient): SchoolSenderReader {
  return createSchoolSenderReader(async (fromDomain, text) => {
    const skill = await loadCronSkill(SCHOOL_SENDER_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: schoolSenderInput(fromDomain, text),
      toolName: SCHOOL_SENDER_TOOL,
      toolDescription: SCHOOL_SENDER_DESCRIPTION,
      inputJsonSchema: SCHOOL_SENDER_SCHEMA,
      schema: schoolSenderParse,
      maxTokens: SCHOOL_SENDER_MAX_TOKENS,
    });
    return value;
  });
}
