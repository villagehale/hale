import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-245 · M10 — the party read: what a parent texted, turned into an occasion.
 * Prompt is the `party-extraction` SKILL body (rule #2: never inline). Single
 * forced-tool turn, Zod-validated.
 *
 * Injected behind {@link PartyExtractor} so the handler depends on the CONTRACT rather
 * than on Anthropic: the handler's tests drive a Fake to exercise routing (rule #8 —
 * the fake is for plumbing only; extraction QUALITY is the eval's job, against real
 * cached Claude in apps/worker/evals/run-rsvp-eval.mjs).
 *
 * TWO DETERMINISTIC GUARDS SIT AFTER THE MODEL, and both exist because this extraction
 * feeds a page strangers read:
 *
 *   1. An unparseable or offset-less `starts_at` is dropped to null rather than
 *      coerced. A date Hale could not read is a date Hale must ask about.
 *   2. A `starts_at` at or before the message's own arrival is dropped to null. A party
 *      in the past is not a party — it is a misread year or a hallucinated month, and
 *      it is the single most damaging thing this stage can get wrong, because the
 *      invite would go out and nobody would come.
 *
 * Both land on the same branch: null date → the ONE clarifying question. The handler
 * never guesses and never asks twice.
 */

const MAX_TOKENS = 512;
/** Nothing a parent is planning is more than two years out; beyond that the model read
 * a year wrong. Bounded here rather than in the prompt so it is enforced, not asked. */
const MAX_LEAD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export interface ExtractedParty {
  /** False for every message that is not a party the parent is HOSTING. */
  isParty: boolean;
  title: string | null;
  /** Null when the model could not resolve a date confidently, or resolved a bad one. */
  startsAt: Date | null;
  location: string | null;
  childName: string | null;
}

export interface PartyExtractor {
  extract(input: { message: string; receivedAt: Date; timeZone: string }): Promise<ExtractedParty>;
}

const partyOutputSchema = z.object({
  is_party: z.boolean(),
  title: z.string().nullable().optional().default(null),
  starts_at: z.string().nullable().optional().default(null),
  location: z.string().nullable().optional().default(null),
  child_name: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1),
});

const partyOutputJsonSchema = {
  type: 'object',
  properties: {
    is_party: { type: 'boolean' },
    title: { type: ['string', 'null'] },
    starts_at: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    child_name: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['is_party', 'confidence'],
} as const;

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function partyUserMessage(input: {
  message: string;
  receivedAt: Date;
  timeZone: string;
}): string {
  return JSON.stringify({
    message: input.message,
    received_at: input.receivedAt.toISOString(),
    timezone: input.timeZone,
  });
}

/**
 * Guard #1 and #2 in one place, exported so the eval scores the SAME rule the runtime
 * applies rather than a re-description of it.
 */
export function resolvePartyStart(raw: string | null, receivedAt: Date): Date | null {
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() <= receivedAt.getTime()) return null;
  if (parsed.getTime() - receivedAt.getTime() > MAX_LEAD_MS) return null;
  return parsed;
}

export function createPartyExtractor(client: AgentClient): PartyExtractor {
  return {
    async extract(input) {
      const skill = await loadCronSkill('party-extraction');
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: partyUserMessage(input),
        toolName: 'party',
        toolDescription: 'Return the party the parent described, or is_party false.',
        inputJsonSchema: partyOutputJsonSchema,
        schema: partyOutputSchema,
        maxTokens: MAX_TOKENS,
      });

      // A party with no name is not a party Hale can publish — there would be nothing
      // on the card. Treated as "not a party" rather than titled by Hale, because a
      // title Hale wrote is a claim the parent never made.
      if (!value.is_party || value.title === null || value.title.trim().length === 0) {
        return { isParty: false, title: null, startsAt: null, location: null, childName: null };
      }

      return {
        isParty: true,
        title: value.title.trim(),
        startsAt: resolvePartyStart(value.starts_at, input.receivedAt),
        location: value.location?.trim() || null,
        childName: value.child_name?.trim() || null,
      };
    },
  };
}
