import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The cancellation text a parent gets when an event they were texted a tap-to-add link
 * for is cancelled — written by a model (skill `calendar-cancel-voice`).
 *
 * A deferral is NAMED and the caller sends the deterministic receipt instead
 * (templates/calendar-cancel/sms.ts): a parent planning around a cancelled event is
 * worse off with no text than with a plain one.
 */

const LINK_SHAPE = /https?:\/\/|www\./i;
const THIRD_PERSON_SELF =
  /\bHale\s+(can|could|will|would|is|isn't|has|have|cancelled|canceled|took|removed|might|may)\b/i;
const FIRST_PERSON_PLURAL = /\b(we|we're|we'll|we've|us|our|ours)\b/i;

export const MAX_CANCEL_CHARS = 160;
const MAX_ATTEMPTS = 3;
const MAX_TOKENS = 160;

export interface CalendarCancelRequest {
  /** The event, already rendered at this parent's own privacy level. */
  summary: string;
  /** When it was going to start, in the family's timezone (inviteWhenLabel). */
  when: string;
}

export type CalendarCancelRefusal =
  | 'empty'
  | 'over_char_cap'
  | 'carries_link'
  | 'not_a_sentence'
  | 'third_person_self'
  | 'first_person_plural'
  | 'summary_missing'
  | 'cancel_word_missing'
  | 'invented_number';

export function calendarCancelRefusals(
  body: string,
  request: CalendarCancelRequest,
): CalendarCancelRefusal[] {
  if (body === '') return ['empty'];
  const found: CalendarCancelRefusal[] = [];
  if (body.length > MAX_CANCEL_CHARS) found.push('over_char_cap');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  if (THIRD_PERSON_SELF.test(body)) found.push('third_person_self');
  if (FIRST_PERSON_PLURAL.test(body)) found.push('first_person_plural');
  const lower = body.toLowerCase();
  if (!lower.includes(request.summary.toLowerCase())) found.push('summary_missing');
  if (!/cancel/i.test(body)) found.push('cancel_word_missing');
  const handed = new Set(`${request.summary} ${request.when}`.match(/\d+/g) ?? []);
  if ((body.match(/\d+/g) ?? []).some((n) => !handed.has(n))) found.push('invented_number');
  return found;
}

export interface RejectedCalendarCancel {
  text: string;
  problems: CalendarCancelRefusal[];
}

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function calendarCancelUserMessage(
  request: CalendarCancelRequest,
  rejected: readonly RejectedCalendarCancel[] = [],
): string {
  const base = { summary: request.summary, when: request.when };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

export type CalendarCancelDeferral =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type CalendarCancelOutcome =
  | { status: 'composed'; body: string }
  | { status: 'deferred'; reason: CalendarCancelDeferral };

export interface CalendarCancelVoice {
  compose(request: CalendarCancelRequest): Promise<CalendarCancelOutcome>;
}

const textSchema = z.object({ text: z.string() });
const textJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

function errorClass(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function deferred(reason: CalendarCancelDeferral, detail?: string): CalendarCancelOutcome {
  console.error({ reason, detail }, 'calendar cancel: no text composed, sending the receipt');
  return { status: 'deferred', reason };
}

export function createCalendarCancelVoice(client: () => AgentClient): CalendarCancelVoice {
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
        skill = await loadCronSkill('calendar-cancel-voice');
      } catch (err) {
        return deferred('skill_unavailable', errorClass(err));
      }
      const rejected: RejectedCalendarCancel[] = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: calendarCancelUserMessage(request, rejected),
            toolName: 'cancellation',
            toolDescription: 'Return the one short text telling the parent the event is cancelled.',
            inputJsonSchema: textJsonSchema,
            schema: textSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.text;
        } catch (err) {
          return deferred('model_failed', errorClass(err));
        }
        const body = plainText(raw);
        const problems = calendarCancelRefusals(body, request);
        if (problems.length === 0) return { status: 'composed', body };
        rejected.push({ text: body, problems });
      }
      return deferred('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}

let cached: Anthropic | undefined;

export function calendarCancelVoiceClient(): AgentClient {
  cached ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
  return cached;
}

export function productionCalendarCancelVoice(): CalendarCancelVoice {
  return createCalendarCancelVoice(calendarCancelVoiceClient);
}
