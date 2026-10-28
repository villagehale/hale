import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { FamilyEventNotes } from '@hale/db';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventDescriptor, isPrivateEvent } from '~/lib/loop/templates/reminder/core';
import type { ReminderChild, ReminderEventView } from '~/lib/loop/templates/reminder/payload';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The reminder text. The model writes the WHOLE message from facts, in the parent's
 * language: no code-built lead, no "day: title at time" line, no joined list, no appended
 * link or suffix. Code owns the facts (redacted at the parent's name level, teen and
 * sensitive events reduced to the bare generic with no place), the model owns every word
 * and the shape. A draft that cannot be written is NOTHING SENT: there is no fallback copy.
 */

export const REMINDER_SKILL = 'reminder';

export interface ReminderEventFacts {
  /** The redacted descriptor: the leveled title, or the bare generic for a private event. */
  what: string;
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
  /** VIL-468. Parking as the source stated it. Absent when unstated or private, so the
   * request is byte-identical to before for every event that states none. */
  parking?: string;
  /** VIL-468. What to bring as the source stated it. Absent when unstated or private. */
  bring?: string;
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
  notes?: FamilyEventNotes | null;
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
        what: eventDescriptor(event, args.children, args.level, now),
        date: localDateFact(start, timeZone),
        allDay,
        start: allDay ? null : localClockFact(start, timeZone),
        end: allDay || !end ? null : localClockFact(end, timeZone),
        location: hidden ? null : event.location?.trim() || null,
        ...logisticsFacts(hidden ? null : event.notes),
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

export const REMINDER_MAX_CHARS = 480;
const URL_SHAPE = /https?:\/\/\S+/gi;

/** Structural refusals only, never wording: empty, too long, or a link not handed. */
export function reminderRefusals(body: string, facts: ReminderFacts): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const found: string[] = [];
  if (text.length > REMINDER_MAX_CHARS) found.push('over_char_cap');
  const urls = text.match(URL_SHAPE) ?? [];
  const link = facts.planLink;
  if (urls.some((url) => link === null || !url.startsWith(link))) found.push('other_link');
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const REMINDER_MAX_ATTEMPTS = 2;

/** The whole reminder, or null after two refused or failed attempts. Null sends nothing. */
export async function composeReminderText(
  client: AgentClient,
  facts: ReminderFacts,
  familyId: string,
): Promise<string | null> {
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
        toolName: 'reminder_text',
        toolDescription: 'The one text Hale sends the parent.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 300,
      });
      const text = value.text.trim();
      const refusals = reminderRefusals(text, facts);
      if (refusals.length === 0) return text;
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
