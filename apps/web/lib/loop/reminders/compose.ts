import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventDescriptor, isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild, ReminderEventView } from '~/lib/loop/templates/reminder/payload';
import { forceToolJson } from '~/lib/pipeline/structured';
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
  /** Where, from the parent's own calendar. Null for a private event or none. */
  location: string | null;
  /**
   * VIL-474 · what changed, recorded only from source data (a provider's value that
   * differs from what Hale had stored, reminders/change.ts), with its old value in the
   * same form as the new one. Null when nothing changed or the source said nothing.
   */
  changed: { field: 'time' | 'date' | 'venue'; from: string } | null;
}

export interface ReminderFacts {
  /** "-P1D" the evening-before reminder, "-PT1H" about an hour out. */
  offset: '-P1D' | '-PT1H';
  /** The send moment, family-local. */
  now: { date: string; time: string };
  events: ReminderEventFacts[];
  /** The /plan link the parent may be handed, or null. Never added by code. */
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
  return {
    offset: args.offset,
    now: { date: localDateFact(now, timeZone), time: localClockFact(now, timeZone) },
    events: args.events.map((event) => {
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
        location: hidden ? null : event.location?.trim() || null,
        changed: changedFact(event.change, timeZone, hidden),
      };
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

/** The whole reminder as its texts, or null after two refused or failed attempts.
 * Null sends nothing: there is no fallback or sorry text. */
export async function composeReminderTexts(
  client: AgentClient,
  facts: ReminderFacts,
  familyId: string,
): Promise<ReminderDraft | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REMINDER_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'reminder: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= REMINDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: reminderUserMessage(facts),
        toolName: 'reminder_texts',
        toolDescription: 'The texts Hale sends the parent, in order.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 1024,
      });
      const texts = value.texts.map((t) => t.trim());
      const refusals = reminderRefusals(texts, facts);
      const bold = value.bold?.trim() || null;
      if (refusals.length === 0) return { texts, bold };
      console.warn({ familyId, attempt, refusals }, 'reminder: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'reminder: compose failed',
      );
    }
  }
  console.error({ familyId, outcome: 'reminder_unwritten' }, 'reminder: nothing sent');
  return null;
}
