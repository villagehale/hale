import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { registrationUrlAllowed } from '~/lib/signup/url';

/**
 * VIL-413 — facts visible on a parent's photo or PDF after signup.
 *
 * Dark (`INBOUND_PHOTO_FACTS_ENABLED` unset): the extract never runs, PDFs stay
 * unwatched files, and the coach's prompt bytes are today's. Lit: one forced-tool
 * turn reads the blocks, Zod validates, a URL that is not a public https page is
 * dropped, and the facts ride this turn only. Nothing is stored. No parent-facing
 * copy is produced here; if the model cannot write the coach reply, nothing is sent.
 */

export const INBOUND_PHOTO_FACTS_ENABLED_ENV = 'INBOUND_PHOTO_FACTS_ENABLED';

/** Exact `true`, no trim: a piped `echo` stores a newline and stays off. */
export function inboundPhotoFactsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[INBOUND_PHOTO_FACTS_ENABLED_ENV] === 'true';
}

const KINDS = [
  'flyer',
  'schedule',
  'registration',
  'permission_slip',
  'other',
  'unreadable',
] as const;

export type PhotoFactKind = (typeof KINDS)[number];

export interface PhotoFacts {
  kind: Exclude<PhotoFactKind, 'unreadable'>;
  title: string | null;
  venue: string | null;
  whenText: string | null;
  registrationUrl: string | null;
  childName: string | null;
  notes: string | null;
  confidence: number;
}

export interface ReadPhotoFactsInput {
  blocks: readonly Anthropic.ContentBlockParam[];
  parentWords: string;
  now: Date;
  timeZone: string | null;
  audience: 'direct' | 'group';
}

const MAX_TOKENS = 512;

const outputSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().nullable().optional().default(null),
  venue: z.string().nullable().optional().default(null),
  when_text: z.string().nullable().optional().default(null),
  registration_url: z.string().nullable().optional().default(null),
  child_name: z.string().nullable().optional().default(null),
  notes: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1).optional().default(0),
});

const outputJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    title: { type: ['string', 'null'] },
    venue: { type: ['string', 'null'] },
    when_text: { type: ['string', 'null'] },
    registration_url: { type: ['string', 'null'] },
    child_name: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['kind'],
} as const;

function blank(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function seenUrl(raw: string | null): string | null {
  if (!raw) return null;
  const allowed = registrationUrlAllowed(raw);
  return allowed.ok ? allowed.href : null;
}

function readableBlocks(
  blocks: readonly Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
  return blocks.filter((block) => block.type === 'image' || block.type === 'document');
}

export function inboundPhotoFactsUserMessage(input: ReadPhotoFactsInput): string {
  return JSON.stringify({
    parent_words: input.parentWords,
    now: input.now.toISOString(),
    timezone: input.timeZone,
    audience: input.audience,
  });
}

/**
 * Drop an unreadable page, a page with no facts, and a URL that is not a public
 * registration page. Exported so tests score the same rule the runtime applies.
 */
export function validateInboundPhotoFacts(raw: z.infer<typeof outputSchema>): PhotoFacts | null {
  if (raw.kind === 'unreadable') return null;
  const title = blank(raw.title);
  const venue = blank(raw.venue);
  const whenText = blank(raw.when_text);
  const registrationUrl = seenUrl(blank(raw.registration_url));
  const childName = blank(raw.child_name);
  const notes = blank(raw.notes);
  if (!title && !venue && !whenText && !registrationUrl && !childName && !notes) return null;
  return {
    kind: raw.kind,
    title,
    venue,
    whenText,
    registrationUrl,
    childName,
    notes,
    confidence: raw.confidence,
  };
}

/** A registration URL Hale already saw on this turn's photo, for offer_signup. */
export function photoFactSignupLinks(
  facts: PhotoFacts | null | undefined,
): { title: string; url: string }[] {
  const url = facts?.registrationUrl;
  if (!url) return [];
  return [{ title: facts.title ?? url, url }];
}

/** `null` returns the same skill object: the addendum rides only when a fact does. */
export function augmentCoachSkillForPhotoFacts(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return {
    ...skill,
    instructions: `${skill.instructions}\n\n${addendum.instructions}`,
  };
}

export async function extractInboundPhotoFacts(
  input: ReadPhotoFactsInput & { client: AgentClient },
): Promise<PhotoFacts | null> {
  const blocks = readableBlocks(input.blocks);
  if (blocks.length === 0) return null;
  const skill = await loadCronSkill('inbound-photo-facts');
  const { value } = await forceToolJson({
    client: input.client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: inboundPhotoFactsUserMessage(input),
    attachments: blocks,
    toolName: 'photo_facts',
    toolDescription: 'Return the facts visible on this turn photo or PDF, or kind unreadable.',
    inputJsonSchema: outputJsonSchema,
    schema: outputSchema,
    maxTokens: MAX_TOKENS,
  });
  return validateInboundPhotoFacts(value);
}
