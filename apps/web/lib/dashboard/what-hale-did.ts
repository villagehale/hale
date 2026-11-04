import { type Database, schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import type { GoogleCalendarSkipReason } from '@hale/worker/google-calendar-placement';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { loadTeenAccessUnlocks } from '~/lib/teen-access';
import { type HistoryView, toHistoryView } from './history';
import { readResolvedActionRows } from './resolved-actions';
import { familyHasTeenager } from './trail-query';

/**
 * "What Hale did" on /privacy: the emails Hale sent for the family and the calendar
 * changes it made, read from executed `actions` rows only — never `audit_log`, so an
 * internal step ("understood a new signal") cannot appear by construction. Each row is
 * a past-tense receipt with one time line in the family's own zone and locale.
 * Session-free; the session wrapper is loadWhatHaleDid in queries.ts.
 */

export type WhatHaleDidKind = 'email' | 'calendar';

/** Hale's own family calendar (family_events), or the parent's Google Calendar. */
export type CalendarTarget = 'hale_calendar' | 'google_calendar';

/** Every action type, so a new one is a compile error here rather than a silent drop. */
export const WHAT_HALE_DID_KIND: Record<ActionType, WhatHaleDidKind | null> = {
  send_email: 'email',
  reply_to_email: 'email',
  calendar_add: 'calendar',
  calendar_move: 'calendar',
  calendar_cancel: 'calendar',
  create_calendar_event: 'calendar',
  update_calendar_event: 'calendar',
  place_supply_order: null,
  cancel_supply_order: null,
  fill_pdf_form: null,
  submit_government_form: null,
  book_clinic_portal: null,
  cancel_clinic_appointment: null,
  share_photos_with_family: null,
  add_to_digest_only: null,
  add_to_routine: null,
};

const LISTED_TYPES = (Object.keys(WHAT_HALE_DID_KIND) as ActionType[]).filter(
  (type) => WHAT_HALE_DID_KIND[type] !== null,
);

/** The dormant seam that writes straight to Google, with no family_events row. */
const GOOGLE_ONLY_TYPES: ReadonlySet<string> = new Set<ActionType>([
  'create_calendar_event',
  'update_calendar_event',
]);

const CALENDAR_LABEL: Record<CalendarTarget, string> = {
  hale_calendar: 'Family calendar',
  google_calendar: 'Google Calendar',
};

/** The past-tense verb for each email kind, and its line when the payload lost its fields. */
const EMAIL_RECEIPT: Record<string, { verb: string; bare: string }> = {
  send_email: { verb: 'Emailed', bare: 'Sent an email' },
  reply_to_email: { verb: 'Replied to', bare: 'Replied to an email' },
};

/** The past-tense verb for each calendar kind, and how it joins the calendars it touched. */
const CALENDAR_RECEIPT: Record<string, { verb: string; joiner: string }> = {
  calendar_add: { verb: 'Added', joiner: 'to' },
  create_calendar_event: { verb: 'Added', joiner: 'to' },
  calendar_move: { verb: 'Moved', joiner: 'on' },
  update_calendar_event: { verb: 'Updated', joiner: 'on' },
  calendar_cancel: { verb: 'Removed', joiner: 'from' },
};

/** The zone and locale a family reads its own clock in. */
export interface FamilyClock {
  timeZone: string;
  locale: string;
}

export interface WhatHaleDidItem {
  id: string;
  kind: WhatHaleDidKind;
  /** The past-tense receipt, naming the recipient or the calendars; the teen
   * placeholder when redacted. */
  what: string;
  /** One time line in the family's zone and locale: the event's own time and when Hale
   * did it for a placement, when it was sent for an email. */
  when: string;
  calendars: readonly CalendarTarget[];
  teenRedacted: boolean;
}

/**
 * Whether the event is on Google because Hale put it there. `already_present` is a retry
 * that found the Google event id Hale stored on its own earlier write, so it counts.
 */
function onGoogle(executorResult: Record<string, unknown> | null): boolean {
  const google = executorResult?.google;
  if (typeof google !== 'object' || google === null || !('status' in google)) return false;
  if (google.status === 'written') return true;
  return (
    google.status === 'skipped' &&
    'reason' in google &&
    google.reason === ('already_present' satisfies GoogleCalendarSkipReason)
  );
}

function calendarsFor(
  view: HistoryView,
  kind: WhatHaleDidKind,
  executorResult: Record<string, unknown> | null,
): CalendarTarget[] {
  if (kind === 'email') return [];
  if (GOOGLE_ONLY_TYPES.has(view.actionType)) return ['google_calendar'];
  return onGoogle(executorResult) ? ['hale_calendar', 'google_calendar'] : ['hale_calendar'];
}

/** A payload string field, trimmed; null when absent or blank. */
function text(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The receipt line. A redacted row's payload is already null, so it keeps the
 * placeholder preview and nothing of the payload can reach the line. */
function receiptLine(view: HistoryView, calendars: readonly CalendarTarget[]): string {
  if (view.teenRedacted || view.payload === null) return view.preview;
  const email = EMAIL_RECEIPT[view.actionType];
  if (email) {
    const to = text(view.payload, 'to');
    const subject = text(view.payload, 'subject');
    if (!to) return email.bare;
    return subject ? `${email.verb} ${to} about ${subject}` : `${email.verb} ${to}`;
  }
  const calendar = CALENDAR_RECEIPT[view.actionType];
  if (!calendar) {
    throw new Error(`receiptLine: ${view.actionType} is not an email or calendar action`);
  }
  const places = calendars.map((target) => CALENDAR_LABEL[target]).join(' and ');
  return `${calendar.verb} ${text(view.payload, 'title') ?? 'an event'} ${calendar.joiner} ${places}`;
}

function yearIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone }).format(at);
}

/** An instant on the family's own clock, with the year only when it is not this year. */
function stamp(at: Date, clock: FamilyClock, now: Date, weekday: boolean): string {
  return new Intl.DateTimeFormat(clock.locale, {
    weekday: weekday ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: yearIn(at, clock.timeZone) === yearIn(now, clock.timeZone) ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: clock.timeZone,
  }).format(at);
}

function timeLine(
  view: HistoryView,
  kind: WhatHaleDidKind,
  doneAt: Date,
  clock: FamilyClock,
  now: Date,
): string {
  const done = stamp(doneAt, clock, now, false);
  if (kind === 'email') return `Sent ${done}`;
  const startsIso = text(view.payload, 'startsAt');
  const startsAt = startsIso ? new Date(startsIso) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) return `Done ${done}`;
  return `${stamp(startsAt, clock, now, true)} · done ${done}`;
}

export function toWhatHaleDidItem(
  view: HistoryView,
  doneAt: Date,
  executorResult: Record<string, unknown> | null,
  clock: FamilyClock,
  now: Date = new Date(),
): WhatHaleDidItem {
  const kind = WHAT_HALE_DID_KIND[view.actionType as ActionType];
  if (!kind) {
    throw new Error(`toWhatHaleDidItem: ${view.actionType} is not an email or calendar action`);
  }
  const calendars = calendarsFor(view, kind, executorResult);
  return {
    id: view.id,
    kind,
    what: receiptLine(view, calendars),
    when: timeLine(view, kind, doneAt, clock, now),
    calendars,
    teenRedacted: view.teenRedacted,
  };
}

/** A family with no member has no zone. The message carries no family id (it is logged). */
export class FamilyWithoutMembersError extends Error {
  constructor() {
    super('readFamilyOwnClock: the family has no members, so it has no zone');
    this.name = 'FamilyWithoutMembersError';
  }
}

/**
 * The family's own clock: the primary parent's `users.timezone` and `users.locale`, or
 * else those of the earliest-joined member. No constant fallback; a family with no
 * member has no zone.
 */
export async function readFamilyOwnClock(
  database: Database,
  familyId: string,
): Promise<FamilyClock> {
  const [row] = await database
    .select({ timeZone: schema.users.timezone, locale: schema.users.locale })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.familyMembers.familyId, familyId))
    .orderBy(
      sql`case when ${schema.familyMembers.role} = 'primary_parent' then 0 else 1 end`,
      asc(schema.familyMembers.joinedAt),
    )
    .limit(1);
  if (!row) throw new FamilyWithoutMembersError();
  return row;
}

/** Executed email and calendar actions, newest first, teen-redacted for this viewer. */
export async function readWhatHaleDid(
  database: Database,
  familyId: string,
  viewerUserId: string | null,
): Promise<WhatHaleDidItem[]> {
  const [familyHasTeen, clock, unlocks] = await Promise.all([
    familyHasTeenager(database, familyId),
    readFamilyOwnClock(database, familyId),
    loadTeenAccessUnlocks(database, familyId, viewerUserId),
  ]);
  const rows = await readResolvedActionRows(database, {
    familyId,
    scope: sql`${eq(schema.actions.userVisibleState, 'autonomous')} and ${inArray(
      schema.actions.actionType,
      LISTED_TYPES,
    )}`,
    unlocks,
    familyHasTeen,
  });
  return rows.map(({ row, executorResult }) =>
    toWhatHaleDidItem(toHistoryView(row, clock.timeZone), row.resolvedAt, executorResult, clock),
  );
}
