import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { isEnabled } from '@hale/flags';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { contactsOutside, mayHideContact } from '~/lib/format/contact-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import { registrationUrlAllowed } from '~/lib/signup/url';

/**
 * VIL-413 — facts visible on a photo or PDF a parent sends Hale 1:1 after signup.
 *
 * Dark (`INBOUND_PHOTO_FACTS_ENABLED` unset): the extract never runs, PDFs stay
 * unwatched files, and the coach's prompt bytes are today's. Lit: one forced-tool
 * turn reads the blocks, Zod validates, and the facts ride this turn only. Nothing is
 * stored. No parent-facing copy is produced here; if the model cannot write the coach
 * reply, nothing is sent.
 *
 * What is on the page is someone else's words, so every field is bounded, a text field
 * that carries a link, a phone or an email is dropped whole (VIL-633, the rule calendar
 * titles follow), and the one URL kept is a public https page.
 */

export const INBOUND_PHOTO_FACTS_ENABLED_ENV = 'INBOUND_PHOTO_FACTS_ENABLED';

/** Exact `true`, no trim: a piped `echo` stores a newline and stays off. */
export function inboundPhotoFactsEnabled(): boolean {
  return isEnabled('inbound-photo-facts');
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
}

/** The extract lane thinks before it answers, and max_tokens caps both. */
const MAX_TOKENS = 1024;

/** The longest text the model may copy into each field. Past a bound the read fails. */
const MAX_CHARS = {
  title: 120,
  venue: 160,
  when: 160,
  childName: 60,
  notes: 240,
  url: 2048,
} as const;

const boundedText = (max: number) => z.string().max(max).nullable();

const outputSchema = z.strictObject({
  kind: z.enum(KINDS),
  title: boundedText(MAX_CHARS.title),
  venue: boundedText(MAX_CHARS.venue),
  when_text: boundedText(MAX_CHARS.when),
  registration_url: boundedText(MAX_CHARS.url),
  child_name: boundedText(MAX_CHARS.childName),
  notes: boundedText(MAX_CHARS.notes),
  confidence: z.number().min(0).max(1),
});

const nullableText = (maxLength: number) => ({ type: ['string', 'null'], maxLength });

const outputJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    title: nullableText(MAX_CHARS.title),
    venue: nullableText(MAX_CHARS.venue),
    when_text: nullableText(MAX_CHARS.when),
    registration_url: nullableText(MAX_CHARS.url),
    child_name: nullableText(MAX_CHARS.childName),
    notes: nullableText(MAX_CHARS.notes),
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: [
    'kind',
    'title',
    'venue',
    'when_text',
    'registration_url',
    'child_name',
    'notes',
    'confidence',
  ],
} as const;

function oneLine(raw: string | null): string | null {
  const flat = raw?.replace(/\s+/g, ' ').trim();
  return flat ? flat : null;
}

/** A field that holds a way to reach someone, or may hide one, is dropped whole. */
function pageText(raw: string | null): string | null {
  const flat = oneLine(raw);
  if (!flat) return null;
  return mayHideContact(flat) || contactsOutside(flat, []).length > 0 ? null : flat;
}

/**
 * The date as the page writes it. A date and a clock are digits by nature, so the
 * "may hide a phone" digit count would drop nearly every schedule; a phone, link or
 * email that reads as one still drops the field.
 */
function pageWhen(raw: string | null): string | null {
  const flat = oneLine(raw);
  if (!flat) return null;
  return contactsOutside(flat, []).length > 0 ? null : flat;
}

function seenUrl(raw: string | null): string | null {
  const flat = oneLine(raw);
  if (!flat) return null;
  const allowed = registrationUrlAllowed(flat);
  // registrationUrlAllowed also admits http on loopback for the local mock form; a
  // page on a photo never gets that.
  if (!allowed.ok || !allowed.href.startsWith('https://')) return null;
  return allowed.href;
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
  });
}

/**
 * Drop an unreadable page, a page with no facts left, and a URL that is not a public
 * https page. Exported so tests score the same rule the runtime applies.
 */
export function validateInboundPhotoFacts(raw: z.infer<typeof outputSchema>): PhotoFacts | null {
  if (raw.kind === 'unreadable') return null;
  const title = pageText(raw.title);
  const venue = pageText(raw.venue);
  const whenText = pageWhen(raw.when_text);
  const registrationUrl = seenUrl(raw.registration_url);
  const childName = pageText(raw.child_name);
  const notes = pageText(raw.notes);
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
