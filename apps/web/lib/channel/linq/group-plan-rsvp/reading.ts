import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { LINQ_TAPBACKS, type LinqTapback } from '../transport';
import { GROUP_PLAN_RSVP_READ_SKILL } from './facts';
import type { PlanRsvpResponse } from './tally';

/**
 * VIL-442 (T15) — the model reads whether a group message is a plan RSVP.
 *
 * Tapbacks are a protocol mapping (Linq reaction types), not a wording rule.
 * Heart / thumbs-up are a yes; thumbs-down is a no. Plain language is read by
 * the skill in any wording. Low confidence means no state change.
 *
 * VIL-471 — the same read covers group polls when `polls` is on the request:
 * a parent starting one (question and choices in their own words), anyone
 * picking a choice in plain language, or asking where the poll stands. The
 * model names the choice by its opaque key; code checks the key exists and
 * never compares the message to an option.
 */

export const GROUP_PLAN_RSVP_INTENTS = [
  'start_tracking',
  'rsvp',
  'edit',
  'ask_tally',
  'start_poll',
  'poll_vote',
  'ask_poll',
  'chatter',
  'unclear',
] as const;
export type GroupPlanRsvpIntent = (typeof GROUP_PLAN_RSVP_INTENTS)[number];

export const GROUP_POLL_INTENTS = ['start_poll', 'poll_vote', 'ask_poll'] as const;
export type GroupPollIntent = (typeof GROUP_POLL_INTENTS)[number];

export function isGroupPollIntent(intent: GroupPlanRsvpIntent): intent is GroupPollIntent {
  return (GROUP_POLL_INTENTS as readonly string[]).includes(intent);
}

/** The live poll as the reader sees it. Keys only, no ids. */
export interface GroupPollReadView {
  question: string | null;
  options: readonly { key: string; text: string }[];
}

export interface GroupPlanRsvpReadInput {
  text: string;
  tapback: LinqTapback | null;
  senderName: string | null;
  plan: {
    title: string;
    deadline: string | null;
    yesNames: string[];
    waitingNames: string[];
  } | null;
  recent: readonly { from: 'hale' | 'member'; text: string }[];
  /** Present only while group polls are on. `live` is null when no poll is open. */
  polls?: { live: GroupPollReadView | null };
}

export interface GroupPlanRsvpReading {
  intent: GroupPlanRsvpIntent;
  planTitle: string | null;
  startsAt: string | null;
  location: string | null;
  deadline: string | null;
  response: PlanRsvpResponse | null;
  headcount: number;
  householdLabel: string | null;
  coversNames: string[];
  confidence: 'high' | 'low';
  /** `start_poll`: the question, in the parent's words, or null when they gave none. */
  pollQuestion?: string | null;
  /** `start_poll`: the choices, in the parent's words and order. */
  pollOptions?: string[];
  /** `poll_vote`: the key of the choice the sender now stands on. */
  pollChoice?: string | null;
}

export interface GroupPlanRsvpReader {
  read(input: GroupPlanRsvpReadInput): Promise<GroupPlanRsvpReading | null>;
}

const outputSchema = z.object({
  intent: z.enum(GROUP_PLAN_RSVP_INTENTS),
  planTitle: z.string().nullable(),
  startsAt: z.string().nullable(),
  location: z.string().nullable(),
  deadline: z.string().nullable(),
  response: z.enum(['yes', 'no', 'maybe']).nullable(),
  headcount: z.number().int().min(1).max(20),
  householdLabel: z.string().nullable(),
  coversNames: z.array(z.string()),
  confidence: z.enum(['high', 'low']),
  pollQuestion: z.string().nullable(),
  pollOptions: z.array(z.string()),
  pollChoice: z.string().nullable(),
});

const outputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: [...GROUP_PLAN_RSVP_INTENTS] },
    planTitle: { type: ['string', 'null'] },
    startsAt: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    deadline: { type: ['string', 'null'] },
    response: { type: ['string', 'null'], enum: ['yes', 'no', 'maybe', null] },
    headcount: { type: 'integer', minimum: 1, maximum: 20 },
    householdLabel: { type: ['string', 'null'] },
    coversNames: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'low'] },
    pollQuestion: { type: ['string', 'null'] },
    pollOptions: { type: 'array', items: { type: 'string' } },
    pollChoice: { type: ['string', 'null'] },
  },
  required: [
    'intent',
    'planTitle',
    'startsAt',
    'location',
    'deadline',
    'response',
    'headcount',
    'householdLabel',
    'coversNames',
    'confidence',
    'pollQuestion',
    'pollOptions',
    'pollChoice',
  ],
} as const;

export function groupPlanRsvpUserMessage(input: GroupPlanRsvpReadInput): string {
  return JSON.stringify({
    text: input.text,
    tapback: input.tapback,
    senderName: input.senderName,
    plan: input.plan,
    recent: input.recent.slice(-6),
    ...(input.polls ? { polls: input.polls } : {}),
  });
}

export function parseLinqTapback(value: string | null): LinqTapback | null {
  if (!value) return null;
  return (LINQ_TAPBACKS as readonly string[]).includes(value) ? (value as LinqTapback) : null;
}

/** Protocol mapping for iMessage tapbacks. Not a wording rule. */
export function tapbackToVote(tapback: LinqTapback | null): PlanRsvpResponse | null {
  if (tapback === 'love' || tapback === 'like' || tapback === 'emphasize') return 'yes';
  if (tapback === 'dislike') return 'no';
  return null;
}

export function readingFromTapback(
  tapback: LinqTapback,
  _senderName: string | null,
): GroupPlanRsvpReading | null {
  const response = tapbackToVote(tapback);
  if (!response) return null;
  return {
    intent: 'rsvp',
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high',
  };
}

export function createGroupPlanRsvpReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupPlanRsvpReader {
  const once = async (input: GroupPlanRsvpReadInput): Promise<GroupPlanRsvpReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill(GROUP_PLAN_RSVP_READ_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupPlanRsvpUserMessage(input),
      toolName: 'group_plan_rsvp',
      toolDescription: 'Return what this group message meant for a shared plan.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: GROUP_PLAN_RSVP_READ_MAX_TOKENS,
    });
    return value;
  };
  return {
    async read(input) {
      if (!input.text.trim() && input.tapback) {
        return readingFromTapback(input.tapback, input.senderName);
      }
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group plan rsvp reader: read failed',
          );
        }
      }
      console.error(
        { outcome: 'group_plan_rsvp_unread' },
        'group plan rsvp reader: no state change',
      );
      return null;
    },
  };
}

let shared: GroupPlanRsvpReader | null = null;

export function sharedGroupPlanRsvpReader(): GroupPlanRsvpReader {
  shared ??= createGroupPlanRsvpReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

export const GROUP_PLAN_RSVP_READ_TOOL_SCHEMA = outputJsonSchema;
export const GROUP_PLAN_RSVP_READ_MAX_TOKENS = 400;
