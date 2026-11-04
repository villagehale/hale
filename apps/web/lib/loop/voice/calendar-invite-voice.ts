import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { textDestination, titleDestination } from './calendar-destination';

/**
 * The tap-to-add text a parent gets after a placement — written by a model (skill
 * `calendar-invite-voice`). VIL-515.
 *
 * The model never sees the URL. It writes the placeholder `[[link]]` once, and code
 * puts the exact link there. A rejected write is retried here (MAX_ATTEMPTS). A
 * deferral after that is NAMED and the caller sends nothing (`compose_deferred`):
 * there is no fixed fallback line.
 *
 * Code checks the link slot, that no other destination is written, the length, and
 * digits that were not handed. Whether the text names the event and states its start
 * is a small judge call (`calendar-invite-time`), in any language and any way of
 * saying the hour. The model's words are not folded.
 */

/** The placeholder the model writes. Code replaces it with the exact ICS url. */
export const INVITE_LINK_SLOT = '[[link]]';

/** Longer than any event name: an input past it is not a name, and is not sent. */
export const MAX_INVITE_SUMMARY_CHARS = 200;

/** The filled text, link included, as the carrier bills it. */
export const MAX_INVITE_SEGMENTS = 5;

const MAX_ATTEMPTS = 3;
const MAX_TOKENS = 500;
const TIME_JUDGE_MAX_TOKENS = 300;

export interface CalendarInviteVoiceRequest {
  /** The event, already rendered at this parent's own privacy level. */
  summary: string;
  /** When it starts, English fact label (inviteWhenLabel). The model restates it. */
  when: string;
  /** The absolute per-event ICS link. The model never sees this. */
  url: string;
  /** The event start. The time judge compares the text to this instant. */
  startsAt: Date;
  /** The parent's zone, so the clock is the one they were told. */
  timeZone: string;
  /** The family's language tag. Null: the skill writes English. */
  language: string | null;
}

export type CalendarInviteRefusal =
  | 'empty'
  | 'carries_destination'
  | 'link_missing'
  | 'link_repeated'
  | 'link_damaged'
  | 'stray_slot'
  | 'when_missing'
  | 'invented_number'
  | 'too_long';

interface ZonedStart {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

/** Local start, as facts for the digit check and the time judge. English weekday is a fact, not a phrase the parent must read. */
export function zonedStart(startsAt: Date, timeZone: string): ZonedStart {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(startsAt);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
    minute: num('minute'),
    weekday,
  };
}

/** The numbers code hands about the start, as a writer may print them. */
export function startNumbers(event: ZonedStart): Set<string> {
  const numbers = new Set<string>();
  const hour12 = event.hour % 12 || 12;
  for (const n of [event.year, event.month, event.day, event.hour, hour12, event.minute]) {
    numbers.add(String(n));
    numbers.add(String(n).padStart(2, '0'));
  }
  return numbers;
}

function allowedDigits(summary: string, event: ZonedStart): Set<string> {
  const allowed = startNumbers(event);
  for (const n of summary.match(/\d+/g) ?? []) allowed.add(n);
  return allowed;
}

/** The slot is read as a gap, so its neighbours never join into a domain. */
function carriesDestination(text: string, event: ZonedStart): boolean {
  return textDestination(text.split(INVITE_LINK_SLOT).join(' '), startNumbers(event)) !== null;
}

/**
 * Code facts only: link slot, no other destination, length, digits that were not in
 * the summary or the start. A time said as "10am", "à 10 h", or "上午10点" is not
 * refused here, and neither is the event named in translation: the time judge reads both.
 */
export function calendarInviteRefusals(
  body: string,
  request: CalendarInviteVoiceRequest,
): CalendarInviteRefusal[] {
  if (body === '') return ['empty'];
  const found: CalendarInviteRefusal[] = [];
  const slotCount = body.split(INVITE_LINK_SLOT).length - 1;
  if (!request.url || slotCount === 0) found.push('link_missing');
  if (slotCount > 1) found.push('link_repeated');
  const starts = zonedStart(request.startsAt, request.timeZone);
  const carriesLink = carriesDestination(body, starts);
  if (carriesLink) found.push('carries_destination');
  const rest = body.split(request.summary).join(' ').split(INVITE_LINK_SLOT).join(' ');
  const allowed = allowedDigits(request.summary, starts);
  if ((rest.match(/\d+/g) ?? []).some((n) => !allowed.has(n))) found.push('invented_number');
  if (slotCount === 1 && request.url && !carriesLink) {
    const withoutSlot = body.replace(INVITE_LINK_SLOT, '');
    if (/\[\[[^\]]*\]\]/.test(withoutSlot)) found.push('stray_slot');
    const filled = fillCalendarInvite(body, request.url);
    if (!filled.includes(request.url)) found.push('link_damaged');
  }
  if (smsSegments(fillCalendarInvite(body, request.url)) > MAX_INVITE_SEGMENTS) {
    found.push('too_long');
  }
  return found;
}

/** The wire body: the placeholder replaced by the exact url. The model's words stay. */
export function fillCalendarInvite(body: string, url: string): string {
  return body.replace(INVITE_LINK_SLOT, url);
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
    language: request.language,
    linkSlot: INVITE_LINK_SLOT,
  };
  return JSON.stringify(rejected.length === 0 ? base : { ...base, rejected });
}

export interface CalendarInviteTimeInput {
  text: string;
  summary: string;
  when: string;
  timeZone: string;
  language: string | null;
  starts: ZonedStart;
}

/** What the time judge is shown. The url is not in it. */
export function calendarInviteTimeUserMessage(input: CalendarInviteTimeInput): string {
  return JSON.stringify({
    text: input.text,
    summary: input.summary,
    when: input.when,
    timeZone: input.timeZone,
    language: input.language,
    starts: input.starts,
  });
}

export function calendarInviteTimeInput(
  text: string,
  request: CalendarInviteVoiceRequest,
): CalendarInviteTimeInput {
  return {
    text,
    summary: request.summary,
    when: request.when,
    timeZone: request.timeZone,
    language: request.language,
    starts: zonedStart(request.startsAt, request.timeZone),
  };
}

/** True when the text names the event and states its start. Null: the judge could not say, so nothing is sent. */
export interface CalendarInviteTimeJudge {
  matches(input: CalendarInviteTimeInput): Promise<boolean | null>;
}

const timeSchema = z.object({ reason: z.string(), match: z.boolean() });
export const timeJsonSchema = {
  type: 'object',
  properties: { reason: { type: 'string' }, match: { type: 'boolean' } },
  required: ['reason', 'match'],
} as const;

export function createCalendarInviteTimeJudge(client: () => AgentClient): CalendarInviteTimeJudge {
  return {
    async matches(input) {
      try {
        const skill = await loadCronSkill('calendar-invite-time');
        const { value } = await forceToolJson({
          client: client(),
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: calendarInviteTimeUserMessage(input),
          toolName: 'time_match',
          toolDescription:
            'Whether the text names this event and states the same start as the facts.',
          inputJsonSchema: timeJsonSchema,
          schema: timeSchema,
          maxTokens: TIME_JUDGE_MAX_TOKENS,
        });
        return value.match;
      } catch (err) {
        console.error(
          { err: err instanceof Error ? err.name : 'unknown' },
          'calendar invite time: judge failed, nothing sent',
        );
        return null;
      }
    },
  };
}

export type CalendarInviteDeferral =
  | 'summary_too_long'
  | 'summary_carries_destination'
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'time_unjudged'
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
 * Code gate over one model write. `accepted` means the link, the length, and the
 * digits are fine. The time judge still has to agree before it is sent.
 */
export function prepareCalendarInvite(
  raw: string,
  request: CalendarInviteVoiceRequest,
):
  | { status: 'accepted'; body: string }
  | { status: 'refused'; text: string; problems: CalendarInviteRefusal[] } {
  const text = raw.trim();
  const problems = calendarInviteRefusals(text, request);
  if (problems.length > 0) return { status: 'refused', text, problems };
  return { status: 'accepted', body: fillCalendarInvite(text, request.url) };
}

export function createCalendarInviteVoice(
  client: () => AgentClient,
  judge: CalendarInviteTimeJudge = createCalendarInviteTimeJudge(client),
): CalendarInviteVoice {
  return {
    async compose(request) {
      if (request.summary.length > MAX_INVITE_SUMMARY_CHARS) {
        return deferred('summary_too_long', String(request.summary.length));
      }
      const held = titleDestination(
        request.summary,
        startNumbers(zonedStart(request.startsAt, request.timeZone)),
      );
      if (held) return deferred('summary_carries_destination', held);
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
              'Return the text Hale sends, with the link placeholder where the tap-to-add link goes.',
            inputJsonSchema: textJsonSchema,
            schema: textSchema,
            maxTokens: MAX_TOKENS,
          });
          raw = value.text;
        } catch (err) {
          return deferred('model_failed', errorClass(err));
        }
        const text = raw.trim();
        const prepared = prepareCalendarInvite(text, request);
        if (prepared.status === 'refused') {
          rejected.push({ text: prepared.text, problems: prepared.problems });
          continue;
        }
        // Judge the pre-fill text so the url never enters the time check.
        const match = await judge.matches(calendarInviteTimeInput(text, request));
        if (match === null) return deferred('time_unjudged');
        if (!match) {
          rejected.push({ text, problems: ['when_missing'] });
          continue;
        }
        return { status: 'composed', body: prepared.body };
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
