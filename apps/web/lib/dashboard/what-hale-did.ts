import { type Database, schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { loadTeenAccessUnlocks } from '~/lib/teen-access';
import { type HistoryView, toHistoryView } from './history';
import { readResolvedActionRows } from './resolved-actions';
import { familyHasTeenager } from './trail-query';

/**
 * "What Hale did" on /privacy: the emails Hale sent for the family and the calendar
 * changes it made, read from executed `actions` rows only — never `audit_log`, so an
 * internal step ("understood a new signal") cannot appear by construction.
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

export interface WhatHaleDidItem {
  id: string;
  kind: WhatHaleDidKind;
  /** The teen-safe preview line, which names the recipient for an email. */
  what: string;
  /** When it executed, in the family's own zone. */
  when: string;
  calendars: readonly CalendarTarget[];
  teenRedacted: boolean;
}

function googleWritten(executorResult: Record<string, unknown> | null): boolean {
  const google = executorResult?.google;
  return typeof google === 'object' && google !== null && 'status' in google
    ? google.status === 'written'
    : false;
}

function calendarsFor(
  view: HistoryView,
  kind: WhatHaleDidKind,
  executorResult: Record<string, unknown> | null,
): CalendarTarget[] {
  if (kind === 'email') return [];
  if (GOOGLE_ONLY_TYPES.has(view.actionType)) return ['google_calendar'];
  return googleWritten(executorResult) ? ['hale_calendar', 'google_calendar'] : ['hale_calendar'];
}

export function toWhatHaleDidItem(
  view: HistoryView,
  executorResult: Record<string, unknown> | null,
): WhatHaleDidItem {
  const kind = WHAT_HALE_DID_KIND[view.actionType as ActionType];
  if (!kind) {
    throw new Error(`toWhatHaleDidItem: ${view.actionType} is not an email or calendar action`);
  }
  return {
    id: view.id,
    kind,
    what: view.preview,
    when: view.resolvedAt,
    calendars: calendarsFor(view, kind, executorResult),
    teenRedacted: view.teenRedacted,
  };
}

/**
 * The family's own zone: the primary parent's `users.timezone`, or else the zone of the
 * earliest-joined member. No constant fallback; a family with no member has no zone.
 */
export async function readFamilyOwnTimezone(database: Database, familyId: string): Promise<string> {
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.familyMembers.familyId, familyId))
    .orderBy(
      sql`case when ${schema.familyMembers.role} = 'primary_parent' then 0 else 1 end`,
      asc(schema.familyMembers.joinedAt),
    )
    .limit(1);
  if (!row) throw new Error(`readFamilyOwnTimezone: family ${familyId} has no members`);
  return row.timezone;
}

/** Executed email and calendar actions, newest first, teen-redacted for this viewer. */
export async function readWhatHaleDid(
  database: Database,
  familyId: string,
  viewerUserId: string | null,
): Promise<WhatHaleDidItem[]> {
  const [familyHasTeen, timeZone, unlocks] = await Promise.all([
    familyHasTeenager(database, familyId),
    readFamilyOwnTimezone(database, familyId),
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
    toWhatHaleDidItem(toHistoryView(row, timeZone), executorResult),
  );
}
