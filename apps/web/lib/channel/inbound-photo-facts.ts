import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { isEnabled } from '@hale/flags';
import { loadCronSkill } from '~/lib/cron/skill';
import { carriesLink } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  PHOTO_FACTS_MAX_TOKENS,
  PHOTO_FACTS_TOOL_DESCRIPTION,
  PHOTO_FACTS_TOOL_NAME,
  type PhotoFacts,
  type PhotoFactsMessage,
  inboundPhotoFactsUserMessage,
  photoFactsJsonSchema,
  photoFactsSchema,
  validateInboundPhotoFacts,
} from './inbound-photo-facts-read';

/**
 * VIL-413 — facts visible on a photo or PDF a parent sends Hale 1:1 after signup.
 *
 * Dark (`INBOUND_PHOTO_FACTS_ENABLED` unset): the extract never runs, PDFs stay
 * unwatched files, and the coach's prompt bytes are today's. Lit: one forced-tool
 * turn reads the blocks, Zod validates, and the facts ride this turn only. Nothing is
 * stored. No parent-facing copy is produced here; if the model cannot write the coach
 * reply, nothing is sent. What code keeps of the read is in inbound-photo-facts-read.ts.
 */

export type { PhotoFactKind, PhotoFacts } from './inbound-photo-facts-read';
export { inboundPhotoFactsUserMessage, validateInboundPhotoFacts };

export const INBOUND_PHOTO_FACTS_ENABLED_ENV = 'INBOUND_PHOTO_FACTS_ENABLED';

/** Exact `true`, no trim: a piped `echo` stores a newline and stays off. */
export function inboundPhotoFactsEnabled(): boolean {
  return isEnabled('inbound-photo-facts');
}

/**
 * The facts a turn carries, and what they were read from. `document` when a PDF rode the
 * read: its text layer can hold words the parent never saw on the page.
 */
export interface TurnPhotoFacts extends PhotoFacts {
  readFrom: 'image' | 'document';
}

export interface ReadPhotoFactsInput extends PhotoFactsMessage {
  blocks: readonly Anthropic.ContentBlockParam[];
}

function readableBlocks(
  blocks: readonly Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
  return blocks.filter((block) => block.type === 'image' || block.type === 'document');
}

/**
 * The registration URL this turn's facts add to the links offer_signup treats as seen.
 * A photo is what the parent is looking at, and the offer only asks: it names the host
 * and waits for their yes. A PDF's URL counts only when the parent typed that whole URL.
 */
export function photoFactSignupLinks(
  facts: TurnPhotoFacts | undefined,
  parentWords: string,
): { title: string; url: string }[] {
  const url = facts?.registrationUrl;
  if (!url) return [];
  if (facts.readFrom === 'document' && !carriesLink(parentWords, url)) return [];
  return [{ title: facts.title ?? url, url }];
}

/**
 * The registration URL this turn's facts add to the links the watch tools treat as seen.
 * A watch polls a page and texts the family without asking again, so a photo's URL never
 * seeds one: only a URL the parent typed whole, whatever the page was.
 */
export function photoFactWatchLinks(
  facts: TurnPhotoFacts | undefined,
  parentWords: string,
): { title: string; url: string }[] {
  const url = facts?.registrationUrl;
  if (!url || !carriesLink(parentWords, url)) return [];
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
    toolName: PHOTO_FACTS_TOOL_NAME,
    toolDescription: PHOTO_FACTS_TOOL_DESCRIPTION,
    inputJsonSchema: photoFactsJsonSchema,
    schema: photoFactsSchema,
    maxTokens: PHOTO_FACTS_MAX_TOKENS,
  });
  return validateInboundPhotoFacts(value);
}
