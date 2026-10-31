import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
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
 *
 * The gate checks facts only: the summary, the link slot, digits that were not handed,
 * and that a stated clock (and any stated day or month) is the event's own start.
 * Tone, length, and the English `when` label are not gates. The model's words are
 * not folded; accents and other scripts stay.
 */

/** The placeholder the model writes. Code replaces it with the exact ICS url. */
export const INVITE_LINK_SLOT = '[[link]]';

const LINK_SHAPE = /https?:\/\/|www\./i;

const MAX_ATTEMPTS = 3;
const MAX_TOKENS = 500;

export interface CalendarInviteVoiceRequest {
  /** The event, already rendered at this parent's own privacy level. */
  summary: string;
  /** When it starts, English fact label (inviteWhenLabel). The model restates it. */
  when: string;
  /** The absolute per-event ICS link. The model never sees this. */
  url: string;
  /** The event start. The time fact is this instant, not the English label. */
  startsAt: Date;
  /** The parent's zone, so the clock is the one they were told. */
  timeZone: string;
  /** The family's language tag. Null: the skill writes English. */
  language: string | null;
}

export type CalendarInviteRefusal =
  | 'empty'
  | 'carries_link'
  | 'link_missing'
  | 'link_repeated'
  | 'link_damaged'
  | 'stray_slot'
  | 'summary_missing'
  | 'when_missing'
  | 'invented_number';

interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

interface StatedClock {
  hour: number;
  minute: number;
}

/** Longest name first so "juillet" wins over "jul". */
const MONTH_NAMES: readonly [string, number][] = [
  ['janvier', 1],
  ['january', 1],
  ['février', 2],
  ['fevrier', 2],
  ['february', 2],
  ['juillet', 7],
  ['september', 9],
  ['septembre', 9],
  ['november', 11],
  ['novembre', 11],
  ['december', 12],
  ['décembre', 12],
  ['decembre', 12],
  ['october', 10],
  ['octobre', 10],
  ['august', 8],
  ['août', 8],
  ['aout', 8],
  ['april', 4],
  ['avril', 4],
  ['march', 3],
  ['mars', 3],
  ['june', 6],
  ['juin', 6],
  ['july', 7],
  ['jan', 1],
  ['feb', 2],
  ['mar', 3],
  ['apr', 4],
  ['may', 5],
  ['mai', 5],
  ['jun', 6],
  ['jul', 7],
  ['aug', 8],
  ['sep', 9],
  ['sept', 9],
  ['oct', 10],
  ['nov', 11],
  ['dec', 12],
];

const MONTH_ALT = [...MONTH_NAMES]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const MONTH_THEN_DAY = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})\\b`, 'giu');
const DAY_THEN_MONTH = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})\\b`, 'giu');

function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase().replace(/\./g, '');
  return MONTH_NAMES.find(([n]) => n === key)?.[1];
}

export function eventClock(startsAt: Date, timeZone: string): ZonedClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(startsAt);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
    minute: num('minute'),
  };
}

function resolveHour(hour: number, ampm: string | undefined, cjk: 'am' | 'pm' | null): number {
  let h = hour;
  const mark = (ampm ?? '').toLowerCase().replace(/[\s.]/g, '');
  const pm = mark.startsWith('p') || cjk === 'pm';
  const am = mark.startsWith('a') || cjk === 'am';
  if (pm && h < 12) h += 12;
  else if (am && h === 12) h = 0;
  return h;
}

function cjkMeridiem(text: string, index: number): 'am' | 'pm' | null {
  const before = text.slice(Math.max(0, index - 4), index);
  if (before.includes('下午') || before.includes('晚上')) return 'pm';
  if (before.includes('上午')) return 'am';
  return null;
}

/** Clocks the reply states: 10:30 AM, 10 h 30, 10時30分. */
export function statedClocks(text: string): StatedClock[] {
  const found: StatedClock[] = [];
  for (const match of text.matchAll(
    /\b(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\s*\.?\s*m\.?|p\s*\.?\s*m\.?)?/gi,
  )) {
    const hour = resolveHour(Number(match[1]), match[3], cjkMeridiem(text, match.index ?? 0));
    found.push({ hour, minute: Number(match[2]) });
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s*h\s*(\d{2})\b/gi)) {
    found.push({ hour: Number(match[1]), minute: Number(match[2]) });
  }
  for (const match of text.matchAll(/(\d{1,2})時(\d{2})分/g)) {
    const hour = resolveHour(Number(match[1]), undefined, cjkMeridiem(text, match.index ?? 0));
    found.push({ hour, minute: Number(match[2]) });
  }
  return found.filter((c) => c.hour >= 0 && c.hour <= 23 && c.minute >= 0 && c.minute <= 59);
}

function statedMonthDays(text: string): { month: number; day: number }[] {
  const pairs: { month: number; day: number }[] = [];
  const lower = text.toLowerCase();
  MONTH_THEN_DAY.lastIndex = 0;
  DAY_THEN_MONTH.lastIndex = 0;
  for (const match of lower.matchAll(MONTH_THEN_DAY)) {
    const month = monthNumber(match[1] ?? '');
    if (month) pairs.push({ month, day: Number(match[2]) });
  }
  for (const match of lower.matchAll(DAY_THEN_MONTH)) {
    const month = monthNumber(match[2] ?? '');
    if (month) pairs.push({ month, day: Number(match[1]) });
  }
  for (const match of text.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    pairs.push({ month: Number(match[1]), day: Number(match[2]) });
  }
  return pairs;
}

function clockMatches(stated: StatedClock, event: ZonedClock): boolean {
  return stated.hour === event.hour && stated.minute === event.minute;
}

/** Longest spelling first. Abbreviations use a letter boundary so "thu" is not "thursday". */
const WEEKDAY_NAMES: readonly [string, number][] = [
  ['wednesday', 3],
  ['thursday', 4],
  ['saturday', 6],
  ['tuesday', 2],
  ['friday', 5],
  ['monday', 1],
  ['sunday', 0],
  ['mercredi', 3],
  ['jeudi', 4],
  ['dimanche', 0],
  ['vendredi', 5],
  ['samedi', 6],
  ['lundi', 1],
  ['mardi', 2],
  ['thurs', 4],
  ['thur', 4],
  ['tues', 2],
  ['wed', 3],
  ['thu', 4],
  ['fri', 5],
  ['sat', 6],
  ['mon', 1],
  ['tue', 2],
  ['sun', 0],
];

const ZH_WEEKDAYS: readonly [string, number][] = [
  ['星期天', 0],
  ['星期日', 0],
  ['星期一', 1],
  ['星期二', 2],
  ['星期三', 3],
  ['星期四', 4],
  ['星期五', 5],
  ['星期六', 6],
  ['礼拜天', 0],
  ['礼拜一', 1],
  ['礼拜二', 2],
  ['礼拜三', 3],
  ['礼拜四', 4],
  ['礼拜五', 5],
  ['礼拜六', 6],
  ['周日', 0],
  ['周一', 1],
  ['周二', 2],
  ['周三', 3],
  ['周四', 4],
  ['周五', 5],
  ['周六', 6],
];

function eventWeekday(startsAt: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone })
    .format(startsAt)
    .toLowerCase();
  const found = WEEKDAY_NAMES.find(([weekday]) => weekday === name);
  if (!found) throw new Error(`calendar invite: unknown weekday ${name}`);
  return found[1];
}

function statedWeekdays(text: string): number[] {
  const lower = text.toLowerCase();
  const found: number[] = [];
  for (const [name, day] of WEEKDAY_NAMES) {
    const boundary = new RegExp(`(?:^|[^\\p{L}])${name}(?=$|[^\\p{L}])`, 'iu');
    if (boundary.test(lower)) found.push(day);
  }
  for (const [name, day] of ZH_WEEKDAYS) {
    if (text.includes(name)) found.push(day);
  }
  return found;
}

/**
 * The time fact. A stated clock must be the event's own start. A stated day or
 * month, when the reply gives one, must be that start too. The English `when`
 * label is not required.
 */
export function timeFactMissing(
  body: string,
  startsAt: Date,
  timeZone: string,
  summary = '',
): boolean {
  // The title is required in the text. A weekday inside it ("Sunday School") is not a date claim.
  let scan = body.split(INVITE_LINK_SLOT).join(' ');
  if (summary) scan = scan.split(summary).join(' ');
  const event = eventClock(startsAt, timeZone);
  const clocks = statedClocks(scan);
  if (clocks.length === 0 || clocks.some((c) => !clockMatches(c, event))) return true;
  const weekday = eventWeekday(startsAt, timeZone);
  if (statedWeekdays(scan).some((day) => day !== weekday)) return true;
  const slash = [...scan.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)];
  if (
    slash.some((match) => {
      const a = Number(match[1]);
      const b = Number(match[2]);
      const asMonthDay = a === event.month && b === event.day;
      const asDayMonth = a === event.day && b === event.month;
      return !asMonthDay && !asDayMonth;
    })
  ) {
    return true;
  }
  return statedMonthDays(scan).some((pair) => pair.month !== event.month || pair.day !== event.day);
}

function allowedDigits(summary: string, event: ZonedClock): Set<string> {
  const allowed = new Set<string>();
  for (const n of summary.match(/\d+/g) ?? []) allowed.add(n);
  const hour12 = event.hour % 12 || 12;
  for (const n of [event.year, event.month, event.day, event.hour, hour12, event.minute]) {
    allowed.add(String(n));
    allowed.add(String(n).padStart(2, '0'));
  }
  return allowed;
}

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
  if (!body.includes(request.summary)) found.push('summary_missing');
  if (timeFactMissing(body, request.startsAt, request.timeZone, request.summary)) {
    found.push('when_missing');
  }
  const rest = body.split(request.summary).join(' ').split(INVITE_LINK_SLOT).join(' ');
  const allowed = allowedDigits(request.summary, eventClock(request.startsAt, request.timeZone));
  if ((rest.match(/\d+/g) ?? []).some((n) => !allowed.has(n))) found.push('invented_number');
  if (slotCount === 1 && request.url && !LINK_SHAPE.test(body)) {
    const withoutSlot = body.replace(INVITE_LINK_SLOT, '');
    if (/\[\[[^\]]*\]\]/.test(withoutSlot)) found.push('stray_slot');
    const filled = fillCalendarInvite(body, request.url);
    if (!filled.includes(request.url)) found.push('link_damaged');
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
 * Fact gate over one model write. `accepted` is the wire body (link filled, words
 * unchanged). A refusal keeps the pre-fill text, so a retry never shows the model the url.
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
              'Return the text Hale sends, with the link placeholder where the tap-to-add link goes.',
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
