import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { activityKeyOf } from './signals';
import { EMPTY_INTENT, type ParentIntent } from './store';

const LINE_TOOL = 'passport_line';
const INTENT_TOOL = 'passport_intent';

const lineSchema = z.object({
  text: z.string(),
  suggestedActivity: z.string().nullable(),
});

const intentSchema = z.object({
  intent: z.enum(['none', 'confirm', 'reassign', 'remove', 'declare']),
  activity: z.string().nullable(),
  level: z.string().nullable(),
  childName: z.string().nullable(),
  season: z.string().nullable(),
  kind: z.enum(['activity', 'outing']).nullable(),
  weeks: z.number().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
});

const lineJsonSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    suggestedActivity: { type: ['string', 'null'] },
  },
  required: ['text', 'suggestedActivity'],
} as const;

const intentJsonSchema = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['none', 'confirm', 'reassign', 'remove', 'declare'] },
    activity: { type: ['string', 'null'] },
    level: { type: ['string', 'null'] },
    childName: { type: ['string', 'null'] },
    season: { type: ['string', 'null'] },
    kind: { type: ['string', 'null'], enum: ['activity', 'outing', null] },
    weeks: { type: ['number', 'null'] },
    start: { type: ['string', 'null'] },
    end: { type: ['string', 'null'] },
  },
  required: ['intent', 'activity', 'level', 'childName', 'season', 'kind', 'weeks', 'start', 'end'],
} as const;

const HALE_DID_IT =
  /\b(i|i've|i have|i'd|hale|we|we've)\b[^.?\n]{0,48}\b(booked|registered|enrolled|signed up)\b/i;
const DID_FOR_THEM = /\b(booked|enrolled|registered)\s+(you|your|them|her|him)\b/i;
const LINK = /https?:\/\/|www\./i;

export interface PassportLineFacts {
  job: 'confirm' | 'acknowledge';
  acknowledgment: 'confirm' | 'remove' | 'reassign' | 'declare' | null;
  language: 'en' | 'fr';
  childName: string | null;
  activity: string | null;
  seasonLabel: string | null;
  sourceLabel: string | null;
  nextStep: { mode: 'next_season' | 'adjacent'; forbiddenActivityKeys: readonly string[] } | null;
}

export type PassportLine =
  | { ok: true; text: string; suggestedActivity: string | null }
  | { ok: false; reason: 'copy_unavailable' };

/**
 * A model that claims Hale booked, registered, or enrolled the child, or that
 * suggests an activity the child already has, does not send. There is no
 * canned sentence to put in its place.
 */
export function lineViolations(
  text: string,
  suggestedActivity: string | null,
  facts: PassportLineFacts,
): string[] {
  const out: string[] = [];
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (!tidy) out.push('the line was empty');
  if (tidy.length > 320) out.push('the line is too long');
  if (LINK.test(tidy)) out.push('the line contains a link');
  if (HALE_DID_IT.test(tidy) || DID_FOR_THEM.test(tidy)) {
    out.push('the line says Hale booked, registered, or enrolled the child');
  }
  const forbidden = new Set(facts.nextStep?.forbiddenActivityKeys ?? []);
  if (facts.activity) forbidden.add(activityKeyOf(facts.activity));
  const suggestedKey = suggestedActivity ? activityKeyOf(suggestedActivity) : null;
  if (!facts.nextStep) {
    if (suggestedActivity) out.push('a next step was suggested when none was allowed');
  } else if (facts.nextStep.mode === 'next_season') {
    if (suggestedActivity) out.push('next season watch must not name a different activity');
  } else if (!suggestedKey || forbidden.has(suggestedKey)) {
    out.push('the suggested activity is one the child already has');
  }
  return out;
}

export async function composePassportLine(
  client: AgentClient | null,
  facts: PassportLineFacts,
): Promise<PassportLine> {
  if (!client) return { ok: false, reason: 'copy_unavailable' };
  let skill: { instructions: string };
  try {
    skill = await loadCronSkill('interest-passport-voice');
  } catch {
    return { ok: false, reason: 'copy_unavailable' };
  }
  let note = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane('draft'),
        system: skill.instructions,
        userMessage: JSON.stringify({ ...facts, violation: note || null }),
        toolName: LINE_TOOL,
        toolDescription: 'One interest-passport line, and the suggested activity if any.',
        inputJsonSchema: lineJsonSchema,
        schema: lineSchema,
        maxTokens: 300,
      });
      const violations = lineViolations(value.text, value.suggestedActivity, facts);
      if (violations.length === 0) {
        return {
          ok: true,
          text: value.text.replace(/\s+/g, ' ').trim(),
          suggestedActivity: value.suggestedActivity,
        };
      }
      note = violations.join(' ');
    } catch {
      return { ok: false, reason: 'copy_unavailable' };
    }
  }
  return { ok: false, reason: 'copy_unavailable' };
}

/**
 * A bare "yes" with no model is not a confirm. Keyword lists are not a parser.
 */
export async function interpretPassportReply(
  client: AgentClient | null,
  inbound: string,
): Promise<ParentIntent> {
  if (!client) return EMPTY_INTENT;
  const trimmed = inbound.trim();
  if (!trimmed) return EMPTY_INTENT;
  let skill: { instructions: string };
  try {
    skill = await loadCronSkill('interest-passport-voice');
  } catch {
    return EMPTY_INTENT;
  }
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane('draft'),
      system: skill.instructions,
      userMessage: JSON.stringify({
        job: 'interpret',
        inbound: trimmed.slice(0, 500),
      }),
      toolName: INTENT_TOOL,
      toolDescription: 'What the parent did with a passport stamp, or none.',
      inputJsonSchema: intentJsonSchema,
      schema: intentSchema,
      maxTokens: 300,
    });
    return value;
  } catch {
    return EMPTY_INTENT;
  }
}

export type { ParentIntent };
