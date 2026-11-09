import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { estimateCostUsd, pickLane } from '@hale/agent';
import type { FamilyEventNotes } from '@hale/db';
import { ZodError, z } from 'zod';
import type { RecordAgentRunInput } from '~/lib/agent-run';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventDescriptor, isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild, ReminderEventView } from '~/lib/loop/templates/reminder/payload';
import {
  type ProviderErrorShape,
  type ProviderFailureClass,
  abortsSendWindow,
  classifyProviderFailure,
  providerErrorShape,
} from '~/lib/monitoring/provider-health';
import { StructuredOutputError, forceToolJson } from '~/lib/pipeline/structured';
import type { SourceChange } from './change';

/**
 * The reminder text. The model writes the WHOLE message from facts, in the parent's
 * language: no code-built lead, no "day: title at time" line, no joined list, no appended
 * link or suffix. Code owns the facts (redacted at the parent's name level, teen and
 * sensitive events reduced to the bare generic with no place), the model owns every word
 * and the shape. A draft that cannot be written is NOTHING SENT: there is no fallback copy.
 */

export const REMINDER_SKILL = 'reminder';

export interface ReminderEventFacts {
  /** The event's own name (its calendar title), or the bare generic for a private event. */
  what: string;
  /** The child it is for, at the parent's name level, or null (none, private, or the
   * title already names them). A separate fact, so the model never gets a "Mia — Swim" label. */
  for: string | null;
  /** The event's day said from the send moment: "today", "tomorrow", or null (further out). */
  day: 'today' | 'tomorrow' | null;
  /** The event's family-local date, written out ("Monday, October 26, 2026"). */
  date: string;
  /** True when the event spans whole days with no clock time. */
  allDay: boolean;
  /** Family-local start with AM/PM ("3:00 PM"), null for an all-day event. */
  start: string | null;
  /** Family-local end with AM/PM, null when unknown or all-day. */
  end: string | null;
  /** VIL-550 · whole minutes from the send moment to `start`, null for an all-day item.
   * The hourly tick sends a T-1h anywhere from 0 to 60 minutes out, so this, never the
   * offset, is how soon it is. */
  minutesUntilStart: number | null;
  /** Where, from the parent's own calendar. Null for a private event or none. */
  location: string | null;
  /**
   * VIL-474 · what changed, recorded only from source data (a provider's value that
   * differs from what Hale had stored, reminders/change.ts), with its old value in the
   * same form as the new one. Null when nothing changed or the source said nothing.
   */
  changed: { field: 'time' | 'date' | 'venue'; from: string } | null;
  /** VIL-468. Parking as the source stated it. Absent when unstated or private, so the
   * request is byte-identical to before for every event that states none. */
  parking?: string;
  /** VIL-468. What to bring as the source stated it. Absent when unstated or private. */
  bring?: string;
  /** VIL-551 · the `what` of each other event in this reminder whose time runs into this
   * one's. Absent when none, so a reminder with no clash sends the same request as before. */
  overlaps?: string[];
}

export interface ReminderFacts {
  /** "-P1D" the evening-before reminder, "-PT1H" the one shortly before it starts. */
  offset: '-P1D' | '-PT1H';
  /** The send moment, family-local. */
  now: { date: string; time: string };
  events: ReminderEventFacts[];
  /** A link the parent may be handed. Always null while /plan is retired; code never adds one. */
  planLink: string | null;
  /** The parent's language tag. */
  language: ReplyLanguage;
}

/** The input event: the redacted view's fields plus end and place. */
export interface ReminderFactEvent extends ReminderEventView {
  endsAt: string | null;
  location: string | null;
  /** VIL-474 · a source-data change (reminders/change.ts), or absent. */
  change?: SourceChange | null;
  notes?: FamilyEventNotes | null;
}

/** The change as a fact, in the same form as the new value. A private event's old
 * venue is withheld exactly as its venue is. */
function changedFact(
  change: SourceChange | null | undefined,
  timeZone: string,
  hidden: boolean,
): ReminderEventFacts['changed'] {
  if (!change) return null;
  if (change.field === 'venue') {
    return hidden ? null : { field: 'venue', from: change.previousLocation };
  }
  const from =
    change.field === 'time'
      ? localClockFact(change.previousStartsAt, timeZone)
      : `${localDateFact(change.previousStartsAt, timeZone)}, ${localClockFact(change.previousStartsAt, timeZone)}`;
  return { field: change.field, from };
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** "Monday, October 26, 2026" in the family's zone. English labels are facts the model
 * restates in the parent's language; it is never shown verbatim by code. */
export function localDateFact(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).format(instant);
}

/** "3:00 PM" in the family's zone — always with the meridiem. */
export function localClockFact(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(instant);
  return `${part(parts, 'hour')}:${part(parts, 'minute')} ${part(parts, 'dayPeriod').toUpperCase()}`;
}

/** "today" / "tomorrow" / null for the event's local day against the send moment's. */
export function relativeDay(
  instant: Date,
  now: Date,
  timeZone: string,
): 'today' | 'tomorrow' | null {
  const ymd = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  const event = ymd(instant);
  if (event === ymd(now)) return 'today';
  // Noon-anchored next day, so a DST shift never lands on the wrong date.
  const [y, m, d] = ymd(now).split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
  return event === next.toISOString().slice(0, 10) ? 'tomorrow' : null;
}

/** Split the leveled descriptor into the event's name and who it is for. */
function nameAndChild(
  event: ReminderFactEvent,
  descriptor: string,
  hidden: boolean,
): { what: string; for: string | null } {
  if (hidden || descriptor === event.title) return { what: descriptor, for: null };
  const suffix = ` — ${event.title}`;
  return descriptor.endsWith(suffix)
    ? { what: event.title, for: descriptor.slice(0, -suffix.length) }
    : { what: descriptor, for: null };
}

function localMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(instant);
  return Number(part(parts, 'hour')) * 60 + Number(part(parts, 'minute'));
}

/** All-day: starts at local midnight and either has no end or runs whole days. */
export function isAllDay(startsAt: Date, endsAt: Date | null, timeZone: string): boolean {
  if (localMinutes(startsAt, timeZone) !== 0) return false;
  if (!endsAt) return true;
  const span = endsAt.getTime() - startsAt.getTime();
  return span > 0 && localMinutes(endsAt, timeZone) === 0 && span >= 23 * 3600_000;
}

/** Only a stated, non-empty fact becomes a key; a private event carries none. */
function logisticsFacts(
  notes: FamilyEventNotes | null | undefined,
): Pick<ReminderEventFacts, 'parking' | 'bring'> {
  const parking = notes?.parking?.trim();
  const bring = notes?.bring?.trim();
  return { ...(parking ? { parking } : {}), ...(bring ? { bring } : {}) };
}

interface TimedSpan {
  start: number;
  end: number;
}

/** A timed event's span; an event with no end is the instant it starts. Null all-day. */
function timedSpan(event: ReminderFactEvent, timeZone: string): TimedSpan | null {
  const start = new Date(event.startsAt);
  const end = event.endsAt ? new Date(event.endsAt) : null;
  if (isAllDay(start, end, timeZone)) return null;
  return { start: start.getTime(), end: (end ?? start).getTime() };
}

/** Back-to-back is not an overlap; two that start together always are. */
function spansOverlap(a: TimedSpan, b: TimedSpan): boolean {
  return a.start === b.start || (a.start < b.end && b.start < a.end);
}

export function reminderFacts(args: {
  events: readonly ReminderFactEvent[];
  children: readonly ReminderChild[];
  level: ChildNameLevel;
  timeZone: string;
  offset: '-P1D' | '-PT1H';
  now: Date;
  planLink: string | null;
  language: ReplyLanguage;
}): ReminderFacts {
  const { timeZone, now } = args;
  const events = args.events.map((event): ReminderEventFacts => {
    const start = new Date(event.startsAt);
    const end = event.endsAt ? new Date(event.endsAt) : null;
    const allDay = isAllDay(start, end, timeZone);
    const hidden = isPrivateEvent(event, args.children, now);
    return {
      ...nameAndChild(event, eventDescriptor(event, args.children, args.level, now), hidden),
      day: relativeDay(start, now, timeZone),
      date: localDateFact(start, timeZone),
      allDay,
      start: allDay ? null : localClockFact(start, timeZone),
      end: allDay || !end ? null : localClockFact(end, timeZone),
      minutesUntilStart: allDay ? null : Math.round((start.getTime() - now.getTime()) / 60_000),
      location: hidden ? null : event.location?.trim() || null,
      changed: changedFact(event.change, timeZone, hidden),
      ...logisticsFacts(hidden ? null : event.notes),
    };
  });
  const spans = args.events.map((event) => timedSpan(event, timeZone));
  return {
    offset: args.offset,
    now: { date: localDateFact(now, timeZone), time: localClockFact(now, timeZone) },
    events: events.map((fact, i) => {
      const own = spans[i];
      const overlaps = own
        ? events.filter((_, j) => {
            const other = spans[j];
            return j !== i && other != null && spansOverlap(own, other);
          })
        : [];
      return overlaps.length > 0 ? { ...fact, overlaps: overlaps.map((o) => o.what) } : fact;
    }),
    planLink: args.planLink,
    language: args.language,
  };
}

/** The user turn. Shared with the eval, which replays this request shape. */
export function reminderUserMessage(facts: ReminderFacts): string {
  return JSON.stringify(facts);
}

const URL_SHAPE = /https?:\/\/\S+/gi;

/**
 * Structural refusals only, never wording or length: no texts, an empty text, or a
 * link that was not handed. The model decides how many texts and where to split
 * (VIL-467); there is no maximum and no character cap.
 */
export function reminderRefusals(texts: readonly string[], facts: ReminderFacts): string[] {
  const trimmed = texts.map((t) => t.trim());
  if (trimmed.length === 0 || trimmed.every((t) => t === '')) return ['empty'];
  const found: string[] = [];
  if (trimmed.some((t) => t === '')) found.push('empty_text');
  const urls = trimmed.flatMap((t) => t.match(URL_SHAPE) ?? []);
  const link = facts.planLink;
  if (urls.some((url) => link === null || !url.startsWith(link))) found.push('other_link');
  return found;
}

const outputSchema = z.object({
  texts: z.array(z.string()).min(1),
  bold: z.string().nullish(),
});
const outputJsonSchema = {
  type: 'object',
  properties: {
    texts: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
      description: 'The texts Hale sends the parent, in order. One or more.',
    },
    bold: {
      type: 'string',
      description:
        'Optional. The exact words, copied from one of your texts, to show in bold. Leave it out for none.',
    },
  },
  required: ['texts'],
} as const;

export const REMINDER_MAX_ATTEMPTS = 2;

/** The written reminder: its texts, and the words (if any) the writer chose to bold. */
export interface ReminderDraft {
  texts: string[];
  /** VIL-474 · exact words from one of `texts`, or null. Code finds them; never offsets. */
  bold: string | null;
}

/**
 * VIL-563 · what the writer produced, named. `refused` is terminal: the model answered
 * every attempt and none was usable. `unavailable` is a fault that can clear without a
 * code change (the provider, the skill file), so the row stays scheduled and the next
 * slot asks again. VIL-586 · `rejected` is terminal too: the provider refused Hale's own
 * request (`bad_request`) or our code threw (`unexpected`). The same request would fail
 * the same way every slot, so it is asked once.
 */
export type ReminderCompose =
  | { status: 'written'; draft: ReminderDraft }
  | { status: 'refused'; refusals: string[] }
  | ({ status: 'unavailable'; cause: ReminderUnavailableCause } & ProviderErrorShape)
  | ({ status: 'rejected'; cause: ReminderRejectedCause } & ProviderErrorShape);

const NO_PROVIDER_ANSWER: ProviderErrorShape = { httpStatus: null, errorType: null };

export type ReminderUnavailableCause = ProviderFailureClass | 'skill_unavailable';

export type ReminderRejectedCause = 'bad_request' | 'unexpected';

const REMINDER_AGENT = 'reminder-voice';

type Attempt =
  | { kind: 'written'; draft: ReminderDraft }
  | { kind: 'refused'; refusals: string[] }
  | ({ kind: 'unavailable'; cause: ProviderFailureClass } & ProviderErrorShape)
  | ({ kind: 'rejected'; cause: ReminderRejectedCause } & ProviderErrorShape);

/** The 4xx statuses the SDK itself retries (request timeout, conflict): the provider's
 * state, not Hale's request, so the same call can succeed later. */
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409]);

/** A thrown error's class. A 4xx the provider classifier only reads as `transient`
 * (its fail-open default) is Hale's own request, refused, unless it is one the SDK
 * retries; auth, usage limit, quota and billing keep their own classes. An APIError with
 * no status (connection, timeout) is transient. Anything that is not an APIError is our
 * bug. */
function throwCause(err: unknown): ProviderFailureClass | ReminderRejectedCause {
  if (!(err instanceof Anthropic.APIError)) return 'unexpected';
  const failure = classifyProviderFailure(err);
  const status = err.status;
  if (
    failure === 'transient' &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    !RETRYABLE_CLIENT_STATUSES.has(status)
  ) {
    return 'bad_request';
  }
  return failure;
}

/** A thrown error, sorted by who failed: the model answering unusably, the provider, or
 * our own code. Logged with the provider's status and error type only, so a 400 caused by
 * Hale's request reads as that rather than as an outage, without the message it quoted. */
function classifyThrow(err: unknown, familyId: string, attempt: number): Attempt {
  if (err instanceof StructuredOutputError) {
    return { kind: 'refused', refusals: [`structured:${err.outcome}`] };
  }
  if (err instanceof ZodError) return { kind: 'refused', refusals: ['schema'] };
  const cause = throwCause(err);
  const shape = providerErrorShape(err);
  console.warn(
    { familyId, attempt, cause, ...shape, err: err instanceof Error ? err.name : 'unknown' },
    'reminder: compose failed',
  );
  if (cause === 'bad_request' || cause === 'unexpected')
    return { kind: 'rejected', cause, ...shape };
  return { kind: 'unavailable', cause, ...shape };
}

/** The whole reminder as its texts, or the named reason there are none. Nothing written
 * sends nothing: there is no fallback or sorry text. Every attempt leaves an agent_runs
 * row (ids and counts only). An attempt that threw records 0 tokens: a structured error
 * carries no usage, so a billed-but-unusable answer is undercounted at $0. */
export async function composeReminderTexts(
  client: AgentClient,
  facts: ReminderFacts,
  familyId: string,
  recordRun: (run: RecordAgentRunInput) => Promise<void>,
): Promise<ReminderCompose> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REMINDER_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'reminder: skill load failed, nothing sent',
    );
    return { status: 'unavailable', cause: 'skill_unavailable', ...NO_PROVIDER_ANSWER };
  }
  const lane = pickLane(skill.meta.task);
  const refusals: string[] = [];
  let unavailable: ({ cause: ReminderUnavailableCause } & ProviderErrorShape) | null = null;
  for (let attempt = 1; attempt <= REMINDER_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    let usage: Anthropic.Usage | null = null;
    let result: Attempt;
    try {
      const answered = await forceToolJson({
        client,
        lane,
        system: skill.instructions,
        userMessage: reminderUserMessage(facts),
        toolName: 'reminder_texts',
        toolDescription: 'The texts Hale sends the parent, in order.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 1024,
      });
      usage = answered.usage;
      const texts = answered.value.texts.map((t) => t.trim());
      const found = reminderRefusals(texts, facts);
      const bold = answered.value.bold?.trim() || null;
      result =
        found.length === 0
          ? { kind: 'written', draft: { texts, bold } }
          : { kind: 'refused', refusals: found };
      if (result.kind === 'refused') {
        console.warn({ familyId, attempt, refusals: found }, 'reminder: draft refused');
      }
    } catch (err) {
      result = classifyThrow(err, familyId, attempt);
    }
    const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    await recordRun({
      familyId,
      agentName: REMINDER_AGENT,
      modelUsed: lane.model,
      promptTokens: (usage?.input_tokens ?? 0) + cacheCreation,
      completionTokens: usage?.output_tokens ?? 0,
      costUsd: usage
        ? estimateCostUsd(lane.model, {
            inputTokens: usage.input_tokens,
            cacheCreationTokens: cacheCreation,
            cacheReadTokens: cacheRead,
            outputTokens: usage.output_tokens,
          })
        : 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheCreation,
      latencyMs: Date.now() - startedAt,
      status: result.kind === 'written' ? 'completed' : 'failed',
    });
    if (result.kind === 'written') return { status: 'written', draft: result.draft };
    if (result.kind === 'rejected') {
      return {
        status: 'rejected',
        cause: result.cause,
        httpStatus: result.httpStatus,
        errorType: result.errorType,
      };
    }
    if (result.kind === 'refused') refusals.push(...result.refusals);
    if (result.kind === 'unavailable') {
      unavailable = {
        cause: result.cause,
        httpStatus: result.httpStatus,
        errorType: result.errorType,
      };
      // An incident class fails for every call until a person acts; a second is waste.
      if (abortsSendWindow(result.cause)) break;
    }
  }
  if (unavailable !== null) return { status: 'unavailable', ...unavailable };
  console.error({ familyId, outcome: 'reminder_unwritten' }, 'reminder: nothing sent');
  return { status: 'refused', refusals: [...new Set(refusals)] };
}
