import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, asc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { familyLocalNow } from '~/lib/channel/coach/local-now';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import { withoutTeenTitles } from '~/lib/channel/linq/kid-event';
import { teenChildIds } from '~/lib/channel/role-scope';
import { type CommitmentCloseOutcome, cancelCommitment } from '~/lib/commitments/ledger';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * IS THE WATCHED ACTIVITY ALREADY ON THE FAMILY'S CALENDAR? (VIL-564)
 *
 * A watch is "I'll keep watching and text you when I learn more". Once the family has
 * signed up and the class is on their calendar, every further follow-up is Hale texting
 * about something they already have. So before a watch's next look, a model reads the
 * watched subject against the family's calendar and the answer is the decision. Code
 * never matches titles: "Parent & Tot Swim" vs "toddler swim lessons", a French title,
 * and a swim meet that shares a word are the model's to tell apart (the
 * activity-watch-calendar-read eval pins them).
 *
 * ONLY `held` CLOSES. A failed read, an unknown clock, and an `unsure` answer all keep
 * today's behaviour and come back as a named outcome (rule #11), because closing a watch
 * the family still wanted is the costly mistake.
 *
 * WHAT REACHES THE MODEL (rule #1): entry titles and family-local times, nothing else. A
 * teen's entry (by child, or by a title the age gate attributes to a teen) and a
 * health-sensitive entry never leave this file; an entry for a different child than the
 * one the watch is about is not this watch's evidence. A Google mirror counts only when
 * it is the mirror of the parent the watch is owed to — a co-parent's own calendar is
 * not read to decide anything about this parent's watch.
 */

const LOOKBACK_DAYS = 14;
const LOOKAHEAD_DAYS = 120;
/** Bounds the prompt: soonest first, so a long mirror cannot crowd the next weeks out. */
const MAX_ENTRIES = 60;
const MAX_TOKENS = 600;
const DAY_MS = 86_400_000;

export interface WatchCalendarEntry {
  title: string;
  /** `YYYY-MM-DD (Weekday)` on the family's clock. */
  day: string;
  /** `HH:MM`, 24-hour, on the family's clock. */
  start: string;
  end: string | null;
}

export interface WatchCalendarInput {
  today: string;
  /** The watch's de-identified search subject. */
  watching: string;
  /** The heard-fact keys of the watch row. */
  toldTheParent: readonly string[];
  calendar: readonly WatchCalendarEntry[];
}

export type WatchCalendarVerdict = 'held' | 'not_held' | 'unsure';

const VERDICTS = ['held', 'not_held', 'unsure'] as const;

// `verdict` is a plain string here so an unknown value is dropped by code, not thrown.
const outputSchema = z.object({ reason: z.string(), verdict: z.string() });

const outputJsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    verdict: { type: 'string', enum: [...VERDICTS] },
  },
  required: ['reason', 'verdict'],
  additionalProperties: false,
} as const;

const TOOL_NAME = 'watch_calendar_read';
const TOOL_DESCRIPTION = "Return whether the family's calendar already holds the watched activity.";

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function watchCalendarUserMessage(input: WatchCalendarInput): string {
  return JSON.stringify({
    today: input.today,
    watching: input.watching,
    toldTheParent: input.toldTheParent,
    calendar: input.calendar,
  });
}

export function acceptWatchCalendarVerdict(
  value: z.infer<typeof outputSchema>,
): WatchCalendarVerdict | null {
  return VERDICTS.find((verdict) => verdict === value.verdict) ?? null;
}

export interface WatchCalendarReader {
  /** Null: the read failed (after its retry). */
  read(input: WatchCalendarInput): Promise<WatchCalendarVerdict | null>;
}

export function createWatchCalendarReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): WatchCalendarReader {
  const once = async (input: WatchCalendarInput): Promise<WatchCalendarVerdict | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('activity-watch-calendar-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: watchCalendarUserMessage(input),
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESCRIPTION,
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: MAX_TOKENS,
    });
    return acceptWatchCalendarVerdict(value);
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const verdict = await once(input);
          if (verdict) return verdict;
        } catch (err) {
          console.error(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'watch calendar reader: read failed',
          );
        }
      }
      return null;
    },
  };
}

export type WatchCalendarRead =
  | { status: 'read'; today: string; calendar: WatchCalendarEntry[] }
  /** No household clock: entry days and times cannot be stated as the family reads them. */
  | { status: 'zone_unknown' };

/** The family's calendar around now, as the model may see it (the file note's rule #1). */
export async function loadWatchCalendar(
  database: Database,
  input: { familyId: string; parentUserId: string; subjectChildId: string | null; now: Date },
): Promise<WatchCalendarRead> {
  const zone = await knownHouseholdTimezone(database, input.familyId);
  if (!zone) return { status: 'zone_unknown' };

  const [children, ownConnections] = await Promise.all([
    database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId)),
    database
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.familyId, input.familyId),
          eq(schema.integrations.userId, input.parentUserId),
        ),
      ),
  ]);
  const ownConnectionIds = ownConnections.map((row) => row.id);
  const rows = await database
    .select({
      title: schema.familyEvents.title,
      childId: schema.familyEvents.childId,
      sensitive: schema.familyEvents.sensitive,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, input.familyId),
        gte(schema.familyEvents.startsAt, new Date(input.now.getTime() - LOOKBACK_DAYS * DAY_MS)),
        lte(schema.familyEvents.startsAt, new Date(input.now.getTime() + LOOKAHEAD_DAYS * DAY_MS)),
        eq(schema.familyEvents.sensitive, false),
        ownConnectionIds.length === 0
          ? householdFamilyEvent()
          : or(
              householdFamilyEvent(),
              and(
                isNull(schema.familyEvents.deletedAt),
                inArray(schema.familyEvents.integrationId, ownConnectionIds),
              ),
            ),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));

  const teens = teenChildIds(children, input.now);
  const childNames = children.map((child) => child.name);
  const teenNames = children.filter((child) => teens.has(child.id)).map((child) => child.name);
  const eligible = rows.filter(
    (row) =>
      !(row.childId !== null && teens.has(row.childId)) &&
      !(
        input.subjectChildId !== null &&
        row.childId !== null &&
        row.childId !== input.subjectChildId
      ),
  );
  const titled = withoutTeenTitles(
    eligible.map((row) => ({ ...row, kidRelated: true })),
    childNames,
    teenNames,
  );

  const local = (instant: Date) => familyLocalNow(instant, zone);
  const today = local(input.now);
  const calendar: WatchCalendarEntry[] = [];
  for (const row of titled) {
    if (row.title === null || row.title.trim() === '') continue;
    const start = local(row.startsAt);
    calendar.push({
      title: row.title.trim(),
      day: `${start.date} (${start.weekday})`,
      start: start.time,
      end: row.endsAt ? local(row.endsAt).time : null,
    });
    if (calendar.length === MAX_ENTRIES) break;
  }
  return { status: 'read', today: `${today.date} (${today.weekday})`, calendar };
}

/** What the check decided, named so the sweep can count each (rule #11). */
export type WatchCalendarOutcome =
  | { outcome: 'on_calendar' }
  | { outcome: 'not_on_calendar' }
  /** Nothing on the calendar in the window: no model call was needed. */
  | { outcome: 'calendar_empty' }
  /** No answer: the watch goes on as it would have without the check. */
  | {
      outcome: 'calendar_unchecked';
      reason: 'zone_unknown' | 'unreadable' | 'unsure' | 'read_failed';
    };

export interface WatchCalendarCheck {
  check(
    database: Database,
    watch: {
      familyId: string;
      parentUserId: string;
      subjectChildId: string | null;
      subject: string;
      heardFacts: readonly string[];
      now: Date;
    },
  ): Promise<WatchCalendarOutcome>;
}

export function createWatchCalendarCheck(
  reader: WatchCalendarReader,
  load: typeof loadWatchCalendar = loadWatchCalendar,
): WatchCalendarCheck {
  return {
    async check(database, watch) {
      let read: WatchCalendarRead;
      try {
        read = await load(database, watch);
      } catch (err) {
        console.error(
          { fault: err instanceof Error ? err.name : typeof err },
          'watch calendar: the calendar read failed - the watch goes on unchecked',
        );
        return { outcome: 'calendar_unchecked', reason: 'unreadable' };
      }
      if (read.status === 'zone_unknown') {
        return { outcome: 'calendar_unchecked', reason: 'zone_unknown' };
      }
      if (read.calendar.length === 0) return { outcome: 'calendar_empty' };
      const verdict = await reader.read({
        today: read.today,
        watching: watch.subject,
        toldTheParent: watch.heardFacts,
        calendar: read.calendar,
      });
      if (verdict === null) return { outcome: 'calendar_unchecked', reason: 'read_failed' };
      if (verdict === 'unsure') return { outcome: 'calendar_unchecked', reason: 'unsure' };
      return { outcome: verdict === 'held' ? 'on_calendar' : 'not_on_calendar' };
    },
  };
}

/** Voids this one watch: the family has the activity, so nothing is left to tell them. */
export function closeWatchOnCalendar(
  database: Database,
  input: { commitmentId: string; familyId: string; now: Date },
): Promise<CommitmentCloseOutcome> {
  return cancelCommitment(database, {
    familyId: input.familyId,
    kind: 'activity_followup',
    reason: 'already_on_calendar',
    now: input.now,
    commitmentId: input.commitmentId,
  });
}

/** The reader's request shape, imported by the activity-watch-calendar-read eval. */
export const WATCH_CALENDAR_TOOL_SCHEMA = outputJsonSchema;
export const WATCH_CALENDAR_TOOL_NAME = TOOL_NAME;
export const WATCH_CALENDAR_TOOL_DESCRIPTION = TOOL_DESCRIPTION;
export const WATCH_CALENDAR_MAX_TOKENS = MAX_TOKENS;
