import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import { type ReplyReading, toReading } from '~/lib/channel/router/resolve';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE MODEL READS THE REPLY (VIL-410).
 *
 * A calendar offer is a question about one future occasion. Whether a parent agreed,
 * and whether the coach's own sentence was an offer, is a reading — an id, a polarity,
 * or a title and an instant. It is not a table of phrases and not a regex over the
 * sentence. The calendar, not this module, decides whether that instant can still be
 * offered: a start that has passed is refused by the recorder, whatever this reading says.
 *
 * One Haiku call, forced tool JSON, and only the words in front of it. No search, no
 * second turn. A missing key, a missing skill, or an unreadable answer is a named
 * `none` / `unresolved` and the turn goes on (rule #11). This module never writes a
 * sentence a parent sees.
 */

const MAX_TOKENS = 256;
const MAX_TEXT_CHARS = 1600;

const parentSchema = z.object({
  target: z.string(),
  polarity: z.string(),
  confidence: z.string(),
  reason: z.string().optional(),
});

const parentJsonSchema = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description:
        "The id of the offer this reply answers; 'none' if it answers none of them; 'ambiguous' if it is clearly an answer but you cannot tell which offer.",
    },
    polarity: { type: 'string', enum: ['yes', 'no', 'unclear'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
  required: ['target', 'polarity', 'confidence', 'reason'],
} as const;

const coachSchema = z.object({
  offer: z.boolean(),
  title: z.string(),
  startsAt: z.string(),
  location: z.string(),
  reason: z.string().optional(),
});

const coachJsonSchema = {
  type: 'object',
  properties: {
    offer: {
      type: 'boolean',
      description:
        'True only when the sentence offers to add one specific occasion that has not started.',
    },
    title: {
      type: 'string',
      description: 'The occasion title from the sentence, or empty when offer is false.',
    },
    startsAt: {
      type: 'string',
      description: 'ISO-8601 start instant, or empty when offer is false.',
    },
    location: { type: 'string', description: 'Place from the sentence, or empty.' },
    reason: { type: 'string' },
  },
  required: ['offer', 'title', 'startsAt', 'location', 'reason'],
} as const;

export type CoachOfferExtraction =
  | { status: 'offer'; title: string; startsAt: Date; location: string | null }
  | {
      status: 'none';
      reason:
        | 'no_offer'
        | 'client_unavailable'
        | 'skill_unavailable'
        | 'model_failed'
        | 'unreadable';
    };

export interface CalendarOfferPorts {
  readParent(input: {
    text: string;
    questions: readonly OpenQuestion[];
    now: Date;
  }): Promise<ReplyReading>;
  readCoach(input: { text: string; now: Date; timeZone: string }): Promise<CoachOfferExtraction>;
}

/** Tests and any router that has not been given a reader. Never calls a model. */
export const calendarOffersIdle: CalendarOfferPorts = {
  readParent: async () => ({ status: 'unresolved', reason: 'no_target' }),
  readCoach: async () => ({ status: 'none', reason: 'no_offer' }),
};

export function parentOfferUserMessage(
  text: string,
  questions: readonly OpenQuestion[],
  now: Date,
): string {
  return JSON.stringify({
    role: 'parent',
    now: now.toISOString(),
    text,
    questions: questions.map((question) => ({
      id: question.id,
      question: question.description,
    })),
  });
}

export function coachOfferUserMessage(text: string, now: Date, timeZone: string): string {
  return JSON.stringify({
    role: 'coach',
    now: now.toISOString(),
    timeZone,
    text,
  });
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/**
 * Turn the coach tool's object into an extraction. A false offer, an empty title, or
 * an instant that does not parse is `none`. A past instant is still returned: the
 * recorder is what refuses it, so a model that names a past start cannot sneak a row in.
 */
export function toCoachOffer(raw: {
  offer: boolean;
  title: string;
  startsAt: string;
  location: string;
}): CoachOfferExtraction {
  if (!raw.offer) return { status: 'none', reason: 'no_offer' };
  const title = raw.title.trim().slice(0, 120);
  if (title === '') return { status: 'none', reason: 'unreadable' };
  const startsAt = new Date(raw.startsAt);
  if (Number.isNaN(startsAt.getTime())) return { status: 'none', reason: 'unreadable' };
  const place = raw.location.trim().slice(0, 120);
  return { status: 'offer', title, startsAt, location: place === '' ? null : place };
}

export function createCalendarOfferReader(client: () => AgentClient): CalendarOfferPorts {
  return {
    async readParent({ text, questions, now }) {
      if (questions.length === 0) return { status: 'unresolved', reason: 'no_target' };
      if (!process.env.ANTHROPIC_API_KEY) {
        return { status: 'unresolved', reason: 'client_unavailable' };
      }
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        console.info(
          { reason: 'client_unavailable', detail: className(err) },
          'calendar offer read: parent',
        );
        return { status: 'unresolved', reason: 'client_unavailable' };
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('calendar-offer-read');
      } catch (err) {
        console.info(
          { reason: 'skill_unavailable', detail: className(err) },
          'calendar offer read: parent',
        );
        return { status: 'unresolved', reason: 'skill_unavailable' };
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: parentOfferUserMessage(text.slice(0, MAX_TEXT_CHARS), questions, now),
          toolName: 'read_parent_reply',
          toolDescription:
            'Read which open calendar offer this reply answers, and whether it was a yes or a no.',
          inputJsonSchema: parentJsonSchema,
          schema: parentSchema,
          maxTokens: MAX_TOKENS,
        });
        return toReading(value, questions);
      } catch (err) {
        console.info(
          { reason: 'model_failed', detail: className(err) },
          'calendar offer read: parent',
        );
        return { status: 'unresolved', reason: 'model_failed' };
      }
    },

    async readCoach({ text, now, timeZone }) {
      if (!process.env.ANTHROPIC_API_KEY) return { status: 'none', reason: 'client_unavailable' };
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        console.info(
          { reason: 'client_unavailable', detail: className(err) },
          'calendar offer read: coach',
        );
        return { status: 'none', reason: 'client_unavailable' };
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('calendar-offer-read');
      } catch (err) {
        console.info(
          { reason: 'skill_unavailable', detail: className(err) },
          'calendar offer read: coach',
        );
        return { status: 'none', reason: 'skill_unavailable' };
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: coachOfferUserMessage(text.slice(0, MAX_TEXT_CHARS), now, timeZone),
          toolName: 'read_coach_sentence',
          toolDescription: 'Read whether this sentence offers to add one specific future occasion.',
          inputJsonSchema: coachJsonSchema,
          schema: coachSchema,
          maxTokens: MAX_TOKENS,
        });
        return toCoachOffer(value);
      } catch (err) {
        console.info(
          { reason: 'model_failed', detail: className(err) },
          'calendar offer read: coach',
        );
        return { status: 'none', reason: 'model_failed' };
      }
    },
  };
}
