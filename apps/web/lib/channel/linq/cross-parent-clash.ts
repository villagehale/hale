import type { ReplyLanguage } from '~/lib/channel/language';
import { hasLinkShape } from '~/lib/format/link-shape';
import { type ClashPerson, type GroupClash, clashSameKid, planWhen } from './group-conflict';

/**
 * VIL-609 — one child's two overlapping plans, each held by a different parent.
 *
 * The child cannot be in two places. Code found the clash; this file is only the
 * facts the model is given to write one private 1:1 line to one of those parents.
 * Nothing here is copy.
 */

export interface CrossParentClashLineInput {
  language: ReplyLanguage;
  kid: string;
  you: { title: string; day: string; start: string; end: string };
  other: { title: string; name: string | null; day: string; start: string; end: string };
}

/** The facts for one parent's 1:1, or null when this parent does not hold one of the two. */
export function crossParentClashLineInput(
  clash: GroupClash,
  parentId: string,
  context: {
    people: readonly ClashPerson[];
    kids: readonly string[];
    timeZone: string;
    language: ReplyLanguage;
  },
): CrossParentClashLineInput | null {
  if (!('plan' in clash.second)) return null;
  const kid = clashSameKid(clash, context.kids);
  if (!kid) return null;
  const pair = [clash.first, clash.second.plan];
  const yours = pair.find((plan) => clash.restsOn[plan.key] === parentId);
  const theirs = pair.find((plan) => clash.restsOn[plan.key] !== parentId);
  if (!yours || !theirs) return null;
  const otherId = clash.restsOn[theirs.key];
  const name =
    (otherId ? context.people.find((person) => person.id === otherId)?.name.trim() : '') || null;
  return {
    language: context.language,
    kid,
    you: { title: yours.title, ...planWhen(yours, context.timeZone, context.language) },
    other: {
      title: theirs.title,
      name,
      ...planWhen(theirs, context.timeZone, context.language),
    },
  };
}

export function crossParentClashUserMessage(input: CrossParentClashLineInput): string {
  return JSON.stringify(input);
}

/** The writer's forced tool, so the model returns only the line. */
export const CROSS_PARENT_CLASH_TOOL = {
  name: 'cross_parent_clash',
  description:
    'The one private message Hale sends this parent about their child being double-booked.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
} as const;

/** A spend bound on the write (rule #7), not a length for the message. */
export const CROSS_PARENT_CLASH_MAX_TOKENS = 300;

/**
 * The text as it may go out, or null: empty, or a link. There is no fallback sentence.
 */
export function crossParentClashTextUsable(text: string): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  if (hasLinkShape(body)) return null;
  return body;
}
