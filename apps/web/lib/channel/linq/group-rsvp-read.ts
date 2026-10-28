import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { tapbackVote } from './group-rsvp-tally';

/**
 * VIL-102 — the model reads whether a group message is an RSVP turn.
 *
 * No keyword list. A failed read stays silent (logged). A tapback with no
 * words is the carrier's reaction type, not a wording rule.
 */

export const RSVP_INTENTS = [
  'track',
  'report',
  'yes',
  'no',
  'pending',
  'permission_yes',
  'permission_no',
  'chatter',
  'unclear',
] as const;
export type GroupRsvpIntent = (typeof RSVP_INTENTS)[number];

export interface GroupRsvpEventFacts {
  title: string | null;
  whenText: string | null;
  location: string | null;
}

export interface GroupRsvpReadInput {
  text: string;
  tapback: string | null;
  senderName: string | null;
  haleNames: readonly string[];
  tracking: boolean;
  /** ISO clock so a named day or time can become whenText without inventing one. */
  now: string;
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface GroupRsvpReading {
  intent: GroupRsvpIntent;
  confidence: number;
  event: GroupRsvpEventFacts;
  householdName: string | null;
}

export interface GroupRsvpReader {
  read(input: GroupRsvpReadInput): Promise<GroupRsvpReading | null>;
}

const outputSchema = z.object({
  intent: z.enum(RSVP_INTENTS),
  confidence: z.number().min(0).max(1),
  event: z
    .object({
      title: z.string().nullable(),
      whenText: z.string().nullable(),
      location: z.string().nullable(),
    })
    .nullable()
    .optional(),
  householdName: z.string().nullable().optional(),
});

const outputJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...RSVP_INTENTS] },
    confidence: { type: 'number' },
    event: {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'] },
        whenText: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
      },
    },
    householdName: { type: ['string', 'null'] },
  },
  required: ['intent', 'confidence'],
} as const;

export const RSVP_READ_MIN_CONFIDENCE = 0.6;
export const RSVP_RECENT_LINES = 8;

export function groupRsvpUserMessage(input: GroupRsvpReadInput): string {
  return JSON.stringify({
    text: input.text,
    tapback: input.tapback,
    senderName: input.senderName,
    haleNames: [...input.haleNames],
    tracking: input.tracking,
    now: input.now,
    recent: input.recent.slice(-RSVP_RECENT_LINES),
  });
}

function emptyEvent(): GroupRsvpEventFacts {
  return { title: null, whenText: null, location: null };
}

function fromTapback(input: GroupRsvpReadInput): GroupRsvpReading | null {
  if (input.text.trim().length > 0) return null;
  const vote = tapbackVote(input.tapback);
  if (!vote || !input.tracking) return null;
  return {
    intent: vote,
    confidence: 1,
    event: emptyEvent(),
    householdName: input.senderName,
  };
}

export function readingOrUnclear(reading: GroupRsvpReading | null): GroupRsvpReading {
  if (!reading || reading.confidence < RSVP_READ_MIN_CONFIDENCE) {
    return {
      intent: 'unclear',
      confidence: reading?.confidence ?? 0,
      event: emptyEvent(),
      householdName: null,
    };
  }
  return reading;
}

export function createGroupRsvpReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupRsvpReader {
  const once = async (input: GroupRsvpReadInput): Promise<GroupRsvpReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-rsvp-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupRsvpUserMessage(input),
      toolName: 'group_rsvp',
      toolDescription: 'Return what this group message means for the RSVP tally.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: 250,
    });
    return {
      intent: value.intent,
      confidence: value.confidence,
      event: {
        title: value.event?.title?.trim() || null,
        whenText: value.event?.whenText?.trim() || null,
        location: value.event?.location?.trim() || null,
      },
      householdName: value.householdName?.trim() || null,
    };
  };
  return {
    async read(input) {
      const tapback = fromTapback(input);
      if (tapback) return tapback;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group rsvp reader: read failed',
          );
        }
      }
      console.error({ outcome: 'rsvp_unread' }, 'group rsvp reader: staying silent');
      return null;
    },
  };
}

let shared: GroupRsvpReader | null = null;

export function sharedGroupRsvpReader(): GroupRsvpReader | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  shared ??= createGroupRsvpReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}
