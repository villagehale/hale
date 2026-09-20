import {
  ACTIVITY_REVIEW_TAGS,
  ACTIVITY_VERDICTS,
  type ActivityReviewTag,
  type ActivityVerdict,
  MAX_ACTIVITY_REVIEW_TAGS,
} from '@hale/db';
import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * WHAT ONE PARENT'S REPLY AMOUNTED TO — the only model call in this feature.
 *
 * IT IS HANDED ONE THING: the parent's inbound body. No title, no venue, no child name,
 * no family id, no area. `stated-state.ts`'s doctrine applies verbatim — it names the
 * STATE, never the SUBJECT — and here that is not a style preference: the subject is
 * resolved deterministically by the caller from the action that placed the row, so a
 * model that could name one would be a model able to attribute a household's opinion to
 * a venue nobody checked.
 *
 * THE OUTPUT IS ASYMMETRIC ON PURPOSE. The IDENTITY field (`verdict`) is strict — an
 * unrecognised value is a parse failure, because a verdict is the whole row. The
 * ATTRIBUTE field (`tags`) is lenient — a missing list is `[]`, a legitimate state, and
 * an unrecognised tag is DROPPED AND COUNTED rather than failing the read. That is the
 * recorded landmine: a strict attribute schema loses the whole answer over one word the
 * model made up. The CHECK on the column is the backstop, never the filter.
 */
export type VerdictOutcome =
  | { status: 'read'; verdict: ActivityVerdict; tags: ActivityReviewTag[]; tagsDropped: number }
  /** The words say nothing a verdict can be made of. Nothing is written. */
  | { status: 'no_verdict'; tagsDropped: number }
  /** The model could not be reached, or the skill could not be loaded. The datum is
   * uncaptured and says so; it never falls back to a guess (rule #11). */
  | { status: 'deferred'; reason: 'client_unavailable' | 'skill_unavailable' }
  /** The call ran and its answer could not be parsed. Named, never silent. */
  | { status: 'extraction_failed'; reason: string };

export interface VerdictReader {
  read(body: string): Promise<VerdictOutcome>;
}

/**
 * The output cap, and it bounds THINKING AND TEXT TOGETHER on Sonnet 5 — the classify
 * lane runs `thinking: 'adaptive'`, and nothing bounds thinking on its own, so a cap
 * sized for the text alone clips the tool call and the whole read is lost. 512 is that
 * cap with the thinking budget in it; the eval's longest fixture asserts the answer is
 * not truncated at it.
 */
const MAX_TOKENS = 512;

/** The four things a reply can amount to: the three stored verdicts plus the honest
 * fourth. `'none'` is never written — it is how the extractor says the words did not
 * say. */
const VERDICT_OR_NONE = [...ACTIVITY_VERDICTS, 'none'] as const;

const VERDICT_TOOL_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: [...VERDICT_OR_NONE],
      description: 'What the reply amounted to, or "none" when the words do not say.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        'At most three tags from the skill\'s closed list, for things the parent actually said. Empty is normal.',
    },
  },
  required: ['verdict'],
};

/** Lenient on the attribute, strict on the identity — see the note at the top. */
const verdictSchema = z.object({
  verdict: z.enum(VERDICT_OR_NONE),
  tags: z.array(z.string()).optional(),
});

export function createVerdictReader(client: () => AgentClient): VerdictReader {
  return {
    async read(body) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch {
        return { status: 'deferred', reason: 'client_unavailable' };
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('activity-verdict');
      } catch {
        return { status: 'deferred', reason: 'skill_unavailable' };
      }

      let value: z.infer<typeof verdictSchema>;
      try {
        const result = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: body,
          toolName: 'activity_verdict',
          toolDescription: 'Return what this reply amounted to.',
          inputJsonSchema: VERDICT_TOOL_SCHEMA,
          schema: verdictSchema,
          maxTokens: MAX_TOKENS,
        });
        value = result.value;
      } catch (err) {
        return {
          status: 'extraction_failed',
          reason: err instanceof Error ? err.message : String(err),
        };
      }

      const { tags, dropped } = keepKnownTags(value.tags ?? []);
      if (value.verdict === 'none') return { status: 'no_verdict', tagsDropped: dropped };
      return {
        status: 'read',
        verdict: value.verdict as ActivityVerdict,
        tags,
        tagsDropped: dropped,
      };
    },
  };
}

/**
 * The eight, and nothing else. A word the model invented is dropped and COUNTED — the
 * count is what would say the vocabulary is missing something real, and silently
 * discarding it would leave that invisible.
 */
export function keepKnownTags(raw: readonly string[]): {
  tags: ActivityReviewTag[];
  dropped: number;
} {
  const known = new Set<string>(ACTIVITY_REVIEW_TAGS);
  const tags: ActivityReviewTag[] = [];
  let dropped = 0;
  for (const tag of raw) {
    if (!known.has(tag)) {
      dropped += 1;
      continue;
    }
    const kept = tag as ActivityReviewTag;
    if (tags.includes(kept)) continue;
    if (tags.length >= MAX_ACTIVITY_REVIEW_TAGS) continue;
    tags.push(kept);
  }
  return { tags, dropped };
}
