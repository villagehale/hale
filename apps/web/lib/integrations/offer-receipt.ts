import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The one line a parent reads after a calendar offer is answered.
 *
 * The facts are decided before this runs. This module only writes them down. A line
 * that drops the title or the rendered instant is not sent: those are the only words
 * that make the receipt true. There is no template to fall back to (rule #11 names
 * the miss `receipt_unsent`).
 */

const MAX_TOKENS = 128;
const MAX_SEGMENTS = 2;

const receiptSchema = z.object({
  line: z.string(),
});

const receiptJsonSchema = {
  type: 'object',
  properties: {
    line: {
      type: 'string',
      description: 'The one text message. Include the title and the rendered instant exactly.',
    },
  },
  required: ['line'],
} as const;

export interface OfferReceiptFacts {
  happened: 'added' | 'declined';
  title: string;
  /** The instant, already rendered the same way the offer named it. */
  when: string;
  parentReply: string;
}

export interface OfferReceiptWriter {
  write(facts: OfferReceiptFacts): Promise<string | null>;
}

/** A line is sendable when it carries both facts and fits in two segments. */
export function receiptLineOk(line: string, facts: OfferReceiptFacts): boolean {
  const text = line.trim();
  if (text === '') return false;
  if (!text.includes(facts.title)) return false;
  if (!text.includes(facts.when)) return false;
  return smsSegments(text) <= MAX_SEGMENTS;
}

export function offerReceiptUserMessage(facts: OfferReceiptFacts): string {
  return JSON.stringify({
    happened: facts.happened,
    title: facts.title,
    when: facts.when,
    parentReply: facts.parentReply.slice(0, 1600),
  });
}

export function createOfferReceiptWriter(client: () => AgentClient): OfferReceiptWriter {
  return {
    async write(facts) {
      if (!process.env.ANTHROPIC_API_KEY) return null;
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        console.info(
          { status: 'receipt_unsent', reason: 'client_unavailable', detail: className(err) },
          'offer receipt',
        );
        return null;
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('offer-receipt');
      } catch (err) {
        console.info(
          { status: 'receipt_unsent', reason: 'skill_unavailable', detail: className(err) },
          'offer receipt',
        );
        return null;
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: offerReceiptUserMessage(facts),
          toolName: 'receipt',
          toolDescription: 'Write the one short receipt for this calendar offer.',
          inputJsonSchema: receiptJsonSchema,
          schema: receiptSchema,
          maxTokens: MAX_TOKENS,
        });
        const line = value.line.trim();
        if (!receiptLineOk(line, facts)) {
          console.info({ status: 'receipt_unsent', reason: 'rejected' }, 'offer receipt');
          return null;
        }
        return line;
      } catch (err) {
        console.info(
          { status: 'receipt_unsent', reason: 'model_failed', detail: className(err) },
          'offer receipt',
        );
        return null;
      }
    },
  };
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}
