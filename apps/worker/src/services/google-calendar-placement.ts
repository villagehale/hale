/**
 * The executor's port for a Google Calendar write that rides along with a
 * Hale placement (VIL-93). The implementation lives in apps/web, because that
 * is where the token vault is. A process that has not bound one gets
 * {@link unwiredGoogleCalendar}, which names itself instead of pretending the
 * event reached Google.
 */

export type GoogleCalendarOp = 'create' | 'update' | 'delete';

export type GoogleCalendarSkipReason =
  | 'not_configured'
  | 'flag_off'
  | 'scope_missing'
  | 'not_connected'
  | 'not_ours'
  | 'ambiguous'
  | 'token_unavailable'
  | 'already_present'
  | 'event_missing';

export type GoogleCalendarSyncReport =
  | { status: 'skipped'; reason: GoogleCalendarSkipReason }
  | { status: 'written'; googleEventId: string }
  | { status: 'failed'; reason: 'google_error' };

export interface GoogleCalendarPlacementRequest {
  familyId: string;
  familyEventId: string;
  op: GoogleCalendarOp;
  /** The parent who approved the placement. Null on an autonomous or resumed pass. */
  actorUserId: string | null;
}

export interface GoogleCalendarPlacement {
  sync(request: GoogleCalendarPlacementRequest): Promise<GoogleCalendarSyncReport>;
}

export const unwiredGoogleCalendar: GoogleCalendarPlacement = {
  async sync() {
    return { status: 'skipped', reason: 'not_configured' };
  },
};
