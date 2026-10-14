import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { WeekdayCare } from '~/lib/care/weekday';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * WHAT A PARENT SAID ABOUT THEIR WEEKDAYS.
 *
 * A model reads the reply. There is no word list and no fixed sentence. The child
 * comes from the ask, never from the words. The cost of a wrong read is a durable
 * fact, so anything short of a high-confidence reading of home, daycare, or
 * starting soon is `nothing_stated`. The caller names that turn `unreadable`.
 *
 * A missing client, a missing skill, or a model failure is the same outcome, and
 * the log names which. The parent's text is never in that line (rule #1, rule #11).
 */

export type WeekdayCareReading =
  | { status: 'read'; care: WeekdayCare; provider: string | null }
  | { status: 'nothing_stated' };

export interface WeekdayCareReader {
  read(text: string): Promise<WeekdayCareReading>;
}

/** One SMS body cannot exceed this by the time it reaches us. */
const MAX_TEXT_CHARS = 1600;

/** A pin longer than this is not a place name a follow-up can say. */
const MAX_PROVIDER_CHARS = 80;

/**
 * Optional `reason`, and a budget that can finish the decision before it.
 * The reason is last. A cut-off reason must not throw away a reading that
 * already named the care (the reply resolver's first live recording).
 */
export const WEEKDAY_CARE_REPLY_MAX_TOKENS = 256;

export const WEEKDAY_CARE_REPLY_TOOL = 'weekday_care_reply';

export const weekdayCareReplySchema = z.object({
  care: z.string(),
  provider: z.string().nullable().optional(),
  confidence: z.string(),
  reason: z.string().optional(),
});

export const WEEKDAY_CARE_REPLY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    care: { type: 'string', enum: ['home', 'daycare', 'starting_soon', 'nothing'] },
    provider: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['care', 'confidence'],
} as const;

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function weekdayCareReplyUserMessage(text: string): string {
  return JSON.stringify({ text });
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function nothing(reason: string, detail?: string): WeekdayCareReading {
  console.info({ reason, detail }, 'weekday care reply: nothing stated');
  return { status: 'nothing_stated' };
}

function pinProvider(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const straightened = raw.replace(/[\u2018\u2019\u02bc]/g, "'").trim();
  if (straightened.length === 0 || straightened.length > MAX_PROVIDER_CHARS) return null;
  return isPrintableGsm7Basic(straightened) ? straightened : null;
}

/**
 * A reading safe to file. High confidence only. A provider only when the care
 * is daycare, and only when the name can ride an SMS as itself.
 */
export function toWeekdayCareReading(raw: {
  care: string;
  provider?: string | null;
  confidence: string;
}): WeekdayCareReading {
  if (raw.care !== 'home' && raw.care !== 'daycare' && raw.care !== 'starting_soon') {
    return { status: 'nothing_stated' };
  }
  if (raw.confidence !== 'high') return { status: 'nothing_stated' };
  return {
    status: 'read',
    care: raw.care,
    provider: raw.care === 'daycare' ? pinProvider(raw.provider) : null,
  };
}

/**
 * `client` is a resolver, not a value. These deps are built for every inbound
 * text, including the ones a deterministic handler answers with no model at
 * all, so a missing key must not throw. It is `nothing_stated`, named in the log.
 */
export function createWeekdayCareReader(client: () => AgentClient): WeekdayCareReader {
  return {
    async read(text) {
      const bounded = text.slice(0, MAX_TEXT_CHARS);
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return nothing('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('weekday-care-reply');
      } catch (err) {
        return nothing('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: weekdayCareReplyUserMessage(bounded),
          toolName: WEEKDAY_CARE_REPLY_TOOL,
          toolDescription: 'Read how this child spends weekdays.',
          inputJsonSchema: WEEKDAY_CARE_REPLY_TOOL_SCHEMA,
          schema: weekdayCareReplySchema,
          maxTokens: WEEKDAY_CARE_REPLY_MAX_TOKENS,
        });
        return toWeekdayCareReading(value);
      } catch (err) {
        return nothing('model_failed', message(err));
      }
    },
  };
}
