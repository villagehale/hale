import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The one line a parent reads after a calendar offer is answered.
 *
 * The facts are decided before this runs. This module only writes them down. An empty
 * line is not sent: there is no template to fall back to (rule #11 names the miss
 * `receipt_unsent`). Whether the line states the facts is the model's judgment — the
 * skill, and the offer-receipt eval judge — not an English word match or a segment cap.
 */

export const OFFER_RECEIPT_MAX_TOKENS = 128;
export const OFFER_RECEIPT_TOOL = 'receipt';
export const OFFER_RECEIPT_TOOL_DESCRIPTION = 'Write the one short receipt for this calendar offer.';

const receiptSchema = z.object({
  line: z.string(),
});

export const offerReceiptToolSchema = {
  type: 'object',
  properties: {
    line: {
      type: 'string',
      description: 'The one text message. Include the title and the rendered instant exactly.',
    },
  },
  required: ['line'],
} as const;

const receiptJsonSchema = offerReceiptToolSchema;

/**
 * Where this receipt's entry went. This path writes `family_events` and does not
 * deliver an ICS, so `ics` is not a value here.
 */
export type OfferReceiptPlace = 'hale_family_calendar';

/** This receipt is one parent, in private. */
export const OFFER_RECEIPT_ADDRESS = 'tu' as const;

export interface OfferReceiptFacts {
  happened: 'added' | 'declined';
  title: string;
  /** The instant, already rendered the same way the offer named it. */
  when: string;
  /** This parent's own message. */
  parentReply: string;
  /**
   * The household's stored language tag, or null when it has none. Null is not
   * English. The writer follows `parentReply`; this tag is only a fallback when
   * those words do not reveal a language.
   */
  language: ReplyLanguage | null;
  /** Whether THIS parent's Google calendar is connected. Not a destination. */
  googleCalendarConnected: boolean;
  /**
   * Where the entry went, or null when nothing was written. The model describes
   * this; code does not turn it into a sentence.
   */
  placedOn: OfferReceiptPlace | null;
  /**
   * Whether this save was written to the parent's Google calendar. Connection
   * is a different fact. This offer path does not write Google, so this is false.
   */
  alsoOnGoogle: boolean;
}

export interface OfferReceiptWriter {
  write(facts: OfferReceiptFacts): Promise<string | null>;
}

export function offerReceiptUserMessage(facts: OfferReceiptFacts): string {
  return JSON.stringify({
    happened: facts.happened,
    title: facts.title,
    when: facts.when,
    parentWords: facts.parentReply.slice(0, 1600),
    language: facts.language,
    address: OFFER_RECEIPT_ADDRESS,
    googleCalendarConnected: facts.googleCalendarConnected,
    placedOn: facts.placedOn,
    alsoOnGoogle: facts.alsoOnGoogle,
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
          toolName: OFFER_RECEIPT_TOOL,
          toolDescription: OFFER_RECEIPT_TOOL_DESCRIPTION,
          inputJsonSchema: receiptJsonSchema,
          schema: receiptSchema,
          maxTokens: OFFER_RECEIPT_MAX_TOKENS,
        });
        const line = value.line.trim();
        if (line === '') {
          console.info({ status: 'receipt_unsent', reason: 'empty' }, 'offer receipt');
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
