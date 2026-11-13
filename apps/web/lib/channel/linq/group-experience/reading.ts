import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PlanRsvpResponse } from '../group-plan-rsvp/tally';

export const GROUP_EXPERIENCE_KINDS = [
  'rsvp_open',
  'rsvp_vote',
  'rsvp_tally',
  'time_open',
  'time_vote',
  'time_lock',
  'link_facts',
  'private_question',
  'none',
] as const;
export type GroupExperienceKind = (typeof GROUP_EXPERIENCE_KINDS)[number];

export const GROUP_EXPERIENCE_READ_SKILL = 'group-experience-read';
export const GROUP_EXPERIENCE_READ_MAX_TOKENS = 400;

export interface GroupExperienceLiveView {
  rsvp: { title: string | null } | null;
  time: { question: string | null; options: readonly { key: string; text: string }[] } | null;
  link: { url: string } | null;
}

export interface GroupExperienceReadInput {
  text: string;
  senderName: string | null;
  live: GroupExperienceLiveView;
  urls: readonly string[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
  /** The asking household's clock, so a proposed time can be placed. Null when Hale has none. */
  clock: { now: string; timeZone: string } | null;
}

export interface GroupExperienceReading {
  kind: GroupExperienceKind;
  title: string | null;
  /**
   * `rsvp_open` / `time_open`: true when the message is about the plan already open
   * (`live.rsvp`), false when it is about another event, null when the reader cannot tell.
   * Only true ties a poll to the open plan.
   */
  samePlan: boolean | null;
  response: PlanRsvpResponse | null;
  optionKey: string | null;
  options: string[];
  /** For each option, the instant it names on `clock` (ISO with offset), or null. */
  starts: (string | null)[];
  confidence: 'high' | 'low';
}

export interface GroupExperienceReader {
  read(input: GroupExperienceReadInput): Promise<GroupExperienceReading | null>;
}

const readingSchema = z.object({
  kind: z.enum(GROUP_EXPERIENCE_KINDS),
  title: z.string().nullable().optional(),
  samePlan: z.boolean().nullable().optional(),
  response: z.enum(['yes', 'no', 'maybe']).nullable().optional(),
  optionKey: z.string().nullable().optional(),
  options: z.array(z.string()).optional(),
  starts: z.array(z.string().nullable()).optional(),
  confidence: z.enum(['high', 'low']).optional(),
});

export const GROUP_EXPERIENCE_READ_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: [...GROUP_EXPERIENCE_KINDS] },
    title: { type: ['string', 'null'] },
    samePlan: { type: ['boolean', 'null'] },
    response: { type: ['string', 'null'], enum: ['yes', 'no', 'maybe', null] },
    optionKey: { type: ['string', 'null'] },
    options: { type: 'array', items: { type: 'string' } },
    starts: { type: 'array', items: { type: ['string', 'null'] } },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['kind'],
} as const;

export function groupExperienceUserMessage(input: GroupExperienceReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderName: input.senderName,
    live: input.live,
    urls: [...input.urls],
    recent: input.recent,
    clock: input.clock,
  });
}

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An instant the model placed on a clock, or null. A label is never parsed as a date. */
export function placedInstant(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || !ISO_WITH_OFFSET.test(text) || Number.isNaN(Date.parse(text))) return null;
  return text;
}

export function parseGroupExperienceReading(value: unknown): GroupExperienceReading | null {
  const parsed = readingSchema.safeParse(value);
  if (!parsed.success) return null;
  const confidence = parsed.data.confidence ?? 'low';
  const kind = confidence === 'low' ? 'none' : parsed.data.kind;
  const raw = parsed.data.options ?? [];
  const rawStarts = parsed.data.starts ?? [];
  // Starts pair with options by position; a list that does not line up places nothing.
  const aligned = rawStarts.length === raw.length;
  const kept = raw
    .map((option, index) => ({
      text: option.trim(),
      start: aligned ? placedInstant(rawStarts[index]) : null,
    }))
    .filter((option) => option.text.length > 0);
  return {
    kind,
    title: parsed.data.title?.trim() || null,
    samePlan: parsed.data.samePlan ?? null,
    response: parsed.data.response ?? null,
    optionKey: parsed.data.optionKey?.trim() || null,
    options: kept.map((option) => option.text),
    starts: kept.map((option) => option.start),
    confidence,
  };
}

export function createGroupExperienceReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupExperienceReader {
  const once = async (input: GroupExperienceReadInput) => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill(GROUP_EXPERIENCE_READ_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupExperienceUserMessage(input),
      toolName: 'group_experience_read',
      toolDescription: 'Name the moment this group message is, or none.',
      inputJsonSchema: GROUP_EXPERIENCE_READ_TOOL_SCHEMA,
      schema: readingSchema,
      maxTokens: GROUP_EXPERIENCE_READ_MAX_TOKENS,
    });
    return parseGroupExperienceReading(value);
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group experience: read failed',
          );
        }
      }
      return null;
    },
  };
}

export function productionGroupExperienceReader(): GroupExperienceReader | undefined {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return undefined;
  return createGroupExperienceReader(() =>
    budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' }),
  );
}
