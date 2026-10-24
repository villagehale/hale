import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The introduction itself: the first message in a new three-way iMessage group with both
 * parents, written by a model (skill `intro-group-voice`). There is no fixed copy under
 * it. A body every attempt fails is a DEFERRAL — nothing is opened, and the pair waits for
 * the next tick (rule #11).
 *
 * WHAT IT MAY SAY is exactly what both parents said yes to twice: each parent's first
 * name, the stage band they share, and the activity if there is one. The phone numbers
 * cross by being in the group, never by being written.
 */

/** Linq refuses a link in the first message of a new chat (1005), and this stage has no
 * tool that could produce one anyway. */
const LINK_SHAPE = /https?:\/\/|www\./i;

const THIRD_PERSON_SELF =
  /\bHale\s+(can|could|will|would|is|isn't|has|have|makes|make|made|might|may|does|knows|thinks|found|sends|texts|introduces)\b/i;

const FIRST_PERSON_PLURAL = /\b(we|we're|we'll|we've|us|our|ours)\b/i;

export const MAX_INTRO_GROUP_CHARS = 480;
export const MAX_INTRO_GROUP_ATTEMPTS = 3;
const MAX_TOKENS = 320;

export interface IntroGroupRequest {
  parentAFirstName: string;
  parentBFirstName: string;
  /** The shared stage as a noun ("toddler"), from copy.ts's `stageWord`. */
  stageWord: string;
  /** The civic session's title, verbatim from the dataset. */
  anchorTitle: string | null;
  /** The weekday that session falls on, in side A's wall clock. */
  anchorDay: string | null;
}

export type IntroGroupRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'carries_link'
  | 'not_a_sentence'
  | 'third_person_self'
  | 'first_person_plural'
  | 'parent_name_missing'
  | 'anchor_missing'
  | 'carries_address'
  | 'invented_number';

/** Digits the model was handed. Any other number in the body is its own invention. */
function handedNumbers(request: IntroGroupRequest): Set<string> {
  const handed = [request.anchorTitle ?? '', request.anchorDay ?? ''].join(' ');
  return new Set(handed.match(/\d+/g) ?? []);
}

export function introGroupRefusals(body: string, request: IntroGroupRequest): IntroGroupRefusal[] {
  if (body === '') return ['empty'];
  const found: IntroGroupRefusal[] = [];
  if (body.length > MAX_INTRO_GROUP_CHARS) found.push('over_char_cap');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  if (THIRD_PERSON_SELF.test(body)) found.push('third_person_self');
  if (FIRST_PERSON_PLURAL.test(body)) found.push('first_person_plural');
  const lower = body.toLowerCase();
  if (
    !lower.includes(request.parentAFirstName.toLowerCase()) ||
    !lower.includes(request.parentBFirstName.toLowerCase())
  ) {
    found.push('parent_name_missing');
  }
  if (request.anchorTitle !== null && !lower.includes(request.anchorTitle.toLowerCase())) {
    found.push('anchor_missing');
  }
  if (body.includes('@')) found.push('carries_address');
  const handed = handedNumbers(request);
  if ((body.match(/\d+/g) ?? []).some((n) => !handed.has(n))) found.push('invented_number');
  return found;
}

export interface RejectedIntroGroup {
  intro: string;
  problems: IntroGroupRefusal[];
}

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function introGroupUserMessage(
  request: IntroGroupRequest,
  rejected: readonly RejectedIntroGroup[] = [],
): string {
  const base = {
    parentAFirstName: request.parentAFirstName,
    parentBFirstName: request.parentBFirstName,
    stageWord: request.stageWord,
    anchorTitle: request.anchorTitle,
    anchorDay: request.anchorDay,
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

export type IntroGroupDeferral =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type IntroGroupOutcome =
  | { status: 'composed'; body: string }
  | { status: 'deferred'; reason: IntroGroupDeferral };

export interface IntroGroupVoice {
  compose(request: IntroGroupRequest): Promise<IntroGroupOutcome>;
}

const introSchema = z.object({ intro: z.string() });
const introJsonSchema = {
  type: 'object',
  properties: { intro: { type: 'string' } },
  required: ['intro'],
} as const;

/** The error's class only: an API error's message can quote what was sent (rule #1). */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function deferred(reason: IntroGroupDeferral, detail?: string): IntroGroupOutcome {
  console.error({ reason, detail }, 'village intros: no group intro composed, deferring');
  return { status: 'deferred', reason };
}

export function createIntroGroupVoice(client: () => AgentClient): IntroGroupVoice {
  return {
    async compose(request) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return deferred('client_unavailable', errorClass(err));
      }
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('intro-group-voice');
      } catch (err) {
        return deferred('skill_unavailable', errorClass(err));
      }

      const rejected: RejectedIntroGroup[] = [];
      for (let attempt = 0; attempt < MAX_INTRO_GROUP_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: introGroupUserMessage(request, rejected),
            toolName: 'intro',
            toolDescription: 'Return the one message that introduces these two parents.',
            inputJsonSchema: introJsonSchema,
            schema: introSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.intro;
        } catch (err) {
          return deferred('model_failed', errorClass(err));
        }
        const body = plainText(raw);
        const problems = introGroupRefusals(body, request);
        if (problems.length === 0) return { status: 'composed', body };
        rejected.push({ intro: body, problems });
      }
      return deferred('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}

let cached: Anthropic | undefined;

export function introGroupVoiceClient(): AgentClient {
  cached ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
  return cached;
}

export function productionIntroGroupVoice(): IntroGroupVoice {
  return createIntroGroupVoice(introGroupVoiceClient);
}
