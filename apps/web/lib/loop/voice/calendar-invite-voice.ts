import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { gsmSafe } from '~/lib/loop/templates/weekly-plan/core';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The tap-to-add text a parent gets after a placement — written by a model (skill
 * `calendar-invite-voice`). VIL-515.
 *
 * The model never sees the URL. It writes the placeholder `[[link]]` once, and code
 * puts the exact link there (the same slot rule as said-line). A rejected write is
 * retried here (MAX_ATTEMPTS). A deferral after that is NAMED and the caller sends
 * nothing (`compose_deferred`): there is no fixed fallback line.
 */

/** The placeholder the model writes. Code replaces it with the exact ICS url. */
export const INVITE_LINK_SLOT = '[[link]]';
/** Two GSM-7 segments is the ceiling the old fixed line was held to. */
export const MAX_INVITE_SEGMENTS = 2;

const LINK_SHAPE = /https?:\/\/|www\./i;
const THIRD_PERSON_SELF =
  /\bHale\s+(can|could|will|would|is|isn't|has|have|added|put|texted|sent|might|may)\b/i;
const FIRST_PERSON_PLURAL = /\b(we|we're|we'll|we've|us|our|ours)\b/i;

const MAX_ATTEMPTS = 3;
const MAX_TOKENS = 200;

export interface CalendarInviteVoiceRequest {
  /** The event, already rendered at this parent's own privacy level. */
  summary: string;
  /** When it starts, in the family's timezone (inviteWhenLabel). */
  when: string;
  /** The absolute per-event ICS link. The model never sees this. */
  url: string;
}

export type CalendarInviteRefusal =
  | 'empty'
  | 'over_segment_cap'
  | 'carries_link'
  | 'link_missing'
  | 'link_repeated'
  | 'link_damaged'
  | 'stray_slot'
  | 'not_a_sentence'
  | 'third_person_self'
  | 'first_person_plural'
  | 'summary_missing'
  | 'invented_number';

export function calendarInviteRefusals(
  body: string,
  request: CalendarInviteVoiceRequest,
): CalendarInviteRefusal[] {
  if (body === '') return ['empty'];
  const found: CalendarInviteRefusal[] = [];
  const slotCount = body.split(INVITE_LINK_SLOT).length - 1;
  if (!request.url || slotCount === 0) found.push('link_missing');
  if (slotCount > 1) found.push('link_repeated');
  if (LINK_SHAPE.test(body)) found.push('carries_link');
  if (!/^\p{Lu}/u.test(body)) found.push('not_a_sentence');
  if (THIRD_PERSON_SELF.test(body)) found.push('third_person_self');
  if (FIRST_PERSON_PLURAL.test(body)) found.push('first_person_plural');
  // Fold both sides: a child name arrives with an em dash, and plainText has already
  // folded the model's echo to a hyphen. Comparing the raw summary would refuse the
  // only wording that can go out.
  const summary = plainText(request.summary).toLowerCase();
  if (summary === '' || !body.toLowerCase().includes(summary)) found.push('summary_missing');
  const handed = new Set(`${request.summary} ${request.when}`.match(/\d+/g) ?? []);
  if ((body.match(/\d+/g) ?? []).some((n) => !handed.has(n))) found.push('invented_number');
  if (slotCount === 1 && request.url && !LINK_SHAPE.test(body)) {
    const rest = body.replace(INVITE_LINK_SLOT, '');
    if (/\[\[[^\]]*\]\]/.test(rest)) found.push('stray_slot');
    const filled = fillCalendarInvite(body, request.url);
    if (!filled.includes(request.url)) found.push('link_damaged');
    if (smsEncoding(filled) !== 'gsm7' || smsSegments(filled) > MAX_INVITE_SEGMENTS) {
      found.push('over_segment_cap');
    }
  }
  return found;
}

/** The wire body: the placeholder replaced by the exact url, then GSM-folded. */
export function fillCalendarInvite(body: string, url: string): string {
  return gsmSafe(body.replace(INVITE_LINK_SLOT, url));
}

export interface RejectedCalendarInvite {
  text: string;
  problems: CalendarInviteRefusal[];
}

/** The user-turn payload. The url stays out of it: the model writes the slot. */
export function calendarInviteUserMessage(
  request: CalendarInviteVoiceRequest,
  rejected: readonly RejectedCalendarInvite[] = [],
): string {
  const base = {
    summary: request.summary,
    when: request.when,
    linkSlot: INVITE_LINK_SLOT,
    urlChars: request.url.length,
    maxSegments: MAX_INVITE_SEGMENTS,
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

export type CalendarInviteDeferral =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'gate_exhausted';

export type CalendarInviteVoiceOutcome =
  | { status: 'composed'; body: string }
  | { status: 'deferred'; reason: CalendarInviteDeferral };

export interface CalendarInviteVoice {
  compose(request: CalendarInviteVoiceRequest): Promise<CalendarInviteVoiceOutcome>;
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

function deferred(reason: CalendarInviteDeferral, detail?: string): CalendarInviteVoiceOutcome {
  console.error({ reason, detail }, 'calendar invite: no text composed, nothing sent');
  return { status: 'deferred', reason };
}

/**
 * Structural gate over one model write. `accepted` is the wire body (link filled).
 * A refusal keeps the pre-fill text, so a retry never shows the model the url.
 */
export function prepareCalendarInvite(
  raw: string,
  request: CalendarInviteVoiceRequest,
):
  | { status: 'accepted'; body: string }
  | { status: 'refused'; text: string; problems: CalendarInviteRefusal[] } {
  const text = plainText(raw);
  const problems = calendarInviteRefusals(text, request);
  if (problems.length > 0) return { status: 'refused', text, problems };
  return { status: 'accepted', body: fillCalendarInvite(text, request.url) };
}

export function createCalendarInviteVoice(client: () => AgentClient): CalendarInviteVoice {
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
        skill = await loadCronSkill('calendar-invite-voice');
      } catch (err) {
        return deferred('skill_unavailable', errorClass(err));
      }
      const rejected: RejectedCalendarInvite[] = [];
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        let raw: string;
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: calendarInviteUserMessage(request, rejected),
            toolName: 'calendar_invite',
            toolDescription:
              'Return the one short text telling the parent the event is on the calendar, with the link placeholder where the tap-to-add link goes.',
            inputJsonSchema: textJsonSchema,
            schema: textSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.text;
        } catch (err) {
          return deferred('model_failed', errorClass(err));
        }
        const prepared = prepareCalendarInvite(raw, request);
        if (prepared.status === 'accepted') return { status: 'composed', body: prepared.body };
        rejected.push({ text: prepared.text, problems: prepared.problems });
      }
      return deferred('gate_exhausted', rejected.map((r) => r.problems.join('+')).join(' | '));
    },
  };
}

let cached: Anthropic | undefined;

export function calendarInviteVoiceClient(): AgentClient {
  cached ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
  return cached;
}

export function productionCalendarInviteVoice(): CalendarInviteVoice {
  return createCalendarInviteVoice(calendarInviteVoiceClient);
}
