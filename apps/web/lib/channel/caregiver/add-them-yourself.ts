import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { AddRole } from './parse';

/**
 * The reply to a parent who asks Hale to add someone by number ("add grandma
 * 647-555-0199 as grandparent"). Hale never texts a number first, so the answer is how
 * that person gets in: the parent adds them to their family group with Hale in it, or
 * has them text Hale. The model writes the words; the number never reaches it.
 *
 * Kind `add_them_yourself` of the `group-onboarding-voice` skill. A refused draft is
 * composed once more with the refusal handed back; a second refusal sends nothing and
 * the outcome says why (rule #11).
 */

export const MAX_ADD_THEM_YOURSELF_CHARS = 300;

const MAX_COMPOSE_ATTEMPTS = 2;
const MAX_TOKENS = 200;

const LINK_SHAPE = /https?:\/\/|www\./i;
/** A phone number, or any piece of one. The model was handed no digits. */
const NUMBER_SHAPE = /\d{3,}/;
/** Hale saying it reached the person, or will. It reaches nobody first. */
const CONTACT_CLAIM =
  /\bI(?:['’]ll|['’]ve| will| have| just)?\s+(?:just\s+)?(?:text(?:ed)?|messag(?:e|ed)|invit(?:e|ed)|contact(?:ed)?|reach(?:ed)? out|add(?:ed)?)\b|\bje (?:vais |viens d['’])?(?:lui |leur )?(?:[ée]cri(?:re|t)|texter|inviter|ajouter)\b/i;
const GROUP_WORD = /\bgroup|\bgroupe/i;

export interface AddThemYourselfRequest {
  language: ReplyLanguage;
  /** The name the parent gave, when the command parsed. */
  name: string | null;
  role: AddRole | null;
  /** On SMS there is no group to add them to: they text Hale. */
  channel: 'imessage' | 'sms';
}

export type AddThemYourselfRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'carries_link'
  | 'carries_number'
  | 'claims_contact'
  | 'too_many_questions'
  | 'name_missing'
  | 'group_missing'
  | 'group_on_sms';

/** Every reason this body may not be sent, so one retry can fix all of them. */
export function addThemYourselfRefusals(
  body: string,
  request: AddThemYourselfRequest,
): AddThemYourselfRefusal[] {
  if (body.trim() === '') return ['empty'];
  const found: AddThemYourselfRefusal[] = [];
  if (body.length > MAX_ADD_THEM_YOURSELF_CHARS) found.push('over_char_cap');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (NUMBER_SHAPE.test(body)) found.push('carries_number');
  if (CONTACT_CLAIM.test(body)) found.push('claims_contact');
  if ((body.match(/\?/g) ?? []).length > 1) found.push('too_many_questions');
  if (request.name && !body.toLowerCase().includes(request.name.toLowerCase())) {
    found.push('name_missing');
  }
  if (request.channel === 'imessage' && !GROUP_WORD.test(body)) found.push('group_missing');
  if (request.channel === 'sms' && GROUP_WORD.test(body)) found.push('group_on_sms');
  return found;
}

export interface RejectedAddThemYourself {
  draft: string;
  problems: AddThemYourselfRefusal[];
}

/** The user-turn payload. `rejected` is left out on a first attempt. */
export function addThemYourselfUserMessage(
  request: AddThemYourselfRequest,
  rejected: readonly RejectedAddThemYourself[] = [],
): string {
  const base = {
    kind: 'add_them_yourself',
    language: request.language,
    address: 'tu',
    facts: { name: request.name, role: request.role, channel: request.channel },
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

export type AddThemYourselfUnsent =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable';

export type AddThemYourselfComposed =
  | { status: 'composed'; body: string }
  | { status: 'unsent'; reason: AddThemYourselfUnsent };

export interface AddThemYourselfVoice {
  compose(request: AddThemYourselfRequest): Promise<AddThemYourselfComposed>;
}

const replySchema = z.object({ reply: z.string() });

const replyJsonSchema = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
} as const;

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unsent(reason: AddThemYourselfUnsent, detail?: string): AddThemYourselfComposed {
  console.error({ reason, detail }, 'add them yourself: no reply composed, nothing sent');
  return { status: 'unsent', reason };
}

/** `client` resolves lazily: most inbound turns never reach this composer. */
export function createAddThemYourselfVoice(client: () => AgentClient): AddThemYourselfVoice {
  return {
    async compose(request) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unsent('client_unavailable', message(err));
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('group-onboarding-voice');
      } catch (err) {
        return unsent('skill_unavailable', message(err));
      }
      const rejected: RejectedAddThemYourself[] = [];
      for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: addThemYourselfUserMessage(request, rejected),
            toolName: 'reply',
            toolDescription: 'Return the one reply to the parent.',
            inputJsonSchema: replyJsonSchema,
            schema: replySchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.reply;
        } catch (err) {
          return unsent('model_failed', message(err));
        }
        const body = plainText(raw);
        const problems = addThemYourselfRefusals(body, request);
        if (problems.length === 0) return { status: 'composed', body };
        rejected.push({ draft: body, problems });
      }
      return unsent('unusable', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}
