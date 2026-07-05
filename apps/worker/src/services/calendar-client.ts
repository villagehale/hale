/**
 * CalendarClient — the seam the executor calls for create/update_calendar_event.
 * The interface exists so the executor case is wired and testable NOW, but the
 * real implementation is not built: Google Calendar needs an OAuth app + per-family
 * calendar tokens that do not exist yet (see docs/calendar-integration.md). Until
 * those credentials exist, the real client throws HALE_NOT_CONFIGURED — the same
 * fail-loud semantics the executor had before, now behind the interface instead of
 * an inline throw, so the day the tokens land only this file changes.
 */

export interface CalendarEventInput {
  familyId: string;
  title: string;
  /** ISO 8601 start / end. */
  startsAt: string;
  endsAt: string;
  description?: string;
  /** Provider event id — required for update, absent for create. */
  providerEventId?: string;
}

export interface CalendarEventResult {
  /** The provider's event id, used as the reversal handle. */
  providerEventId: string;
}

export interface CalendarClient {
  createEvent(input: CalendarEventInput): Promise<CalendarEventResult>;
  updateEvent(input: CalendarEventInput): Promise<CalendarEventResult>;
}

function calendarNotConfigured(): Error {
  const err = new Error(
    'HALE_NOT_CONFIGURED: Google Calendar not connected — needs OAuth setup (see docs/calendar-integration.md).',
  );
  err.name = 'HaleNotConfiguredError';
  return err;
}

/**
 * The production client — deliberately unimplemented. Every method throws until a
 * Google Calendar OAuth app + per-family token storage + consent flow exist. This
 * is an honest boundary, not a stub that pretends to succeed (rule #8): "Approved"
 * on a calendar action fails loud rather than silently doing nothing.
 */
export const realCalendarClient: CalendarClient = {
  createEvent(): Promise<CalendarEventResult> {
    throw calendarNotConfigured();
  },
  updateEvent(): Promise<CalendarEventResult> {
    throw calendarNotConfigured();
  },
};
