import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { loadCronSkill } from '~/lib/cron/skill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { textDestination, titleDestination } from './calendar-destination';
import {
  type CalendarInviteTimeInput,
  type CalendarInviteTimeJudge,
  createCalendarInviteTimeJudge,
  zonedStart,
} from './calendar-invite-voice';

/**
 * The cancellation text a parent gets when an event they were texted a tap-to-add link
 * for is cancelled — written by a model (skill `calendar-cancel-voice`).
 *
 * A rejected write is retried here (MAX_ATTEMPTS). A deferral after that is NAMED and
 * the caller sends nothing (calendar-invite.ts `compose_deferred`): there is no fixed
 * fallback text.
 */

/*
 * FACT CHECKS ONLY (VIL-450). The word-matching checks that used to live here
 * (THIRD_PERSON_SELF, first-person-plural, a required "cancel" word, a capital-letter
 * opener, a character cap) broke the no-wording-rules rule and failed every non-English
 * parent. Voice and tone are graded by the judge model in the eval; the gate below only
 * checks facts: no destination, and no number that was not handed. Whether the text
 * names this event (in any language) at its start is the time judge's call (VIL-588).
 */
const MAX_ATTEMPTS = 3;
const MAX_TOKENS = 160;

export interface CalendarCancelRequest {
  /** The event, already rendered at this parent's own privacy level. */
  summary: string;
  /** When it was going to start, in the family's timezone (inviteWhenLabel). */
  when: string;
  /** The event start. The time judge compares the text to this instant. */
  startsAt: Date;
  /** The parent's zone, so the clock is the one they were told. */
  timeZone: string;
}

export type CalendarCancelRefusal =
  | 'empty'
  | 'carries_destination'
  | 'when_missing'
  | 'invented_number';

export function calendarCancelRefusals(
  body: string,
  request: CalendarCancelRequest,
): CalendarCancelRefusal[] {
  if (body === '') return ['empty'];
  const found: CalendarCancelRefusal[] = [];
  if (textDestination(body)) found.push('carries_destination');
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
  | 'summary_carries_destination'
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'time_unjudged'
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
  console.error({ reason, detail }, 'calendar cancel: no text composed, nothing sent');
  return { status: 'deferred', reason };
}

/** What the time judge is shown. The cancel writer is not handed a language. */
function cancelTimeInput(text: string, request: CalendarCancelRequest): CalendarInviteTimeInput {
  return {
    text,
    summary: request.summary,
    when: request.when,
    timeZone: request.timeZone,
    language: null,
    starts: zonedStart(request.startsAt, request.timeZone),
  };
}

export function createCalendarCancelVoice(
  client: () => AgentClient,
  judge: CalendarInviteTimeJudge = createCalendarInviteTimeJudge(client),
): CalendarCancelVoice {
  return {
    async compose(request) {
      const held = titleDestination(request.summary);
      if (held) return deferred('summary_carries_destination', held);
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
        if (problems.length > 0) {
          rejected.push({ text: body, problems });
          continue;
        }
        const match = await judge.matches(cancelTimeInput(body, request));
        if (match === null) return deferred('time_unjudged');
        if (!match) {
          rejected.push({ text: body, problems: ['when_missing'] });
          continue;
        }
        return { status: 'composed', body };
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
