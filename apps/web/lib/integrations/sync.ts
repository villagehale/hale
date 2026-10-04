import type { IngestedEventPayload } from '@hale/tools-contracts';
import { redactEventPayload } from '@hale/worker/redaction';
import { REMINDER_HORIZON_MS } from '~/lib/loop/reminders/schedule';
import type { TravelDetectOutcome } from '~/lib/travel/detect';
import {
  BOOKED_BACKFILL_BUDGET_MS,
  BOOKED_BACKFILL_MAX_PER_SWEEP,
  bookedDetectionBackfillEnabled,
  bookedDetectionEnabledFor,
} from './booked';
import type { CalendarAlertOutcome, CalendarAlertSweep, CalendarChange } from './calendar-alert';
import type { CalendarMirrorCounts } from './calendar-mirror';
import type { EmailAlertResult, GmailAlertEnvelope } from './email-alert';
import type { ConnectorProvider } from './google-oauth';
import type { ActiveConnectorConnection } from './store';
import { type ConnectorErrorCode, ConnectorSyncError, classifyConnectorError } from './sync-error';
import type { OAuthTokens } from './token-vault';

export { BOOKED_BACKFILL_BUDGET_MS, BOOKED_BACKFILL_MAX_PER_SWEEP };

/**
 * Poll-based connector sync (v1) — read-only. Every run pulls the items that
 * changed since the stored cursor from the Google REST API, REDACTS them
 * (rule #1: known child names + dates/postal/email/phone are masked before the
 * payload leaves this module), and enqueues one events.ingested per item. The
 * downstream pipeline classifies → drafts → HOLDS for approval; a connector NEVER
 * executes a side-effect (rule #4).
 *
 * Cursor discipline is the correctness invariant: the cursor (providerMetadata)
 * and lastSyncAt advance ONLY after every item in the batch is enqueued. A failure
 * anywhere marks the connection `error` and leaves the cursor where it was, so the
 * next run re-fetches from the last good point — no item is emitted twice and none
 * is lost.
 *
 * All I/O is injected (Google fetch, enqueue, cursor/token writes) so the mapping
 * and cursor logic are unit-testable without a live Google, queue, or DB.
 */

/** Minimal GET-with-bearer shape so the Google REST calls are mockable in tests. */
export type GoogleFetch = (
  url: string,
  accessToken: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SyncDeps {
  googleFetch: GoogleFetch;
  /** Enqueue one events.ingested payload (the existing pg-boss send). */
  enqueue: (event: IngestedEventPayload) => Promise<void>;
  /** The family's child names, for rule-#1 redaction. */
  childNames: readonly string[];
  /** Persist the advanced cursor + lastSyncAt on success. */
  saveCursor: (id: string, providerMetadata: Record<string, unknown>) => Promise<void>;
  /** Mark the connection errored on failure (cursor left untouched), naming the
   * reason. The code is REQUIRED: a row that stops syncing without saying why is the
   * fifteen-day silence this argument exists to end (rule #11). */
  markError: (id: string, code: ConnectorErrorCode) => Promise<void>;
  /** Refresh an expired access token (Google refresh_token grant). Returns a token
   * set whose refreshToken may be absent — Google omits it on refresh. */
  refreshTokens: (refreshToken: string) => Promise<OAuthTokens>;
  /** Persist a refreshed token set (re-encrypted) by connection id. */
  saveTokens: (id: string, tokens: OAuthTokens) => Promise<void>;
  /**
   * Hand this run's Gmail envelopes to whatever may text the parent about one, and
   * return one named outcome per envelope (lib/integrations/email-alert.ts).
   *
   * NON-NULLABLE (rule #11): "nothing is wired to alert" is a decision a caller makes
   * out loud by passing a port that says so, never by withholding one — the sweep would
   * otherwise read an unset field and a broken wiring identically, which is how a
   * feature ships dark and nobody notices.
   *
   * A rejection is HELD here rather than trusted away: it becomes one `alert_failed` per
   * envelope and leaves the connection healthy, because a bug in Hale's alert path is not
   * a broken mailbox and must not stop the ingest.
   */
  alertGmailEnvelopes: (input: GmailAlertBatch) => Promise<readonly EmailAlertResult[]>;
  /**
   * The same contract for the calendar's raw changes (lib/integrations/calendar-alert.ts),
   * and non-nullable for the same reason: "nothing is wired to alert" is a decision a
   * caller makes out loud, never by withholding a port (rule #11).
   */
  alertCalendarChanges: (input: CalendarAlertBatch) => Promise<CalendarAlertSweep>;
  /**
   * The same contract a THIRD time, for the travel brief's detection pass
   * (lib/travel/detect.ts), and non-nullable for the reason the two above are: "nothing
   * is wired to notice a trip" is a decision a caller makes out loud by passing a port
   * that says so, never by withholding one.
   *
   * It reuses the batch this sweep is already handed, so there is no second Gmail call
   * and no second token read — the body fetch for the handful of booking-shaped
   * envelopes rides the access token already in hand.
   */
  detectTravelBookings: (input: GmailAlertBatch) => Promise<readonly TravelDetectOutcome[]>;
  /**
   * Write eligible upcoming events on this calendar as parent-sourced reminders
   * (lib/integrations/calendar-mirror.ts). Non-nullable (rule #11): a caller that
   * does not mirror passes a port that says so. A rejection is held in the sync
   * and does not mark the connection errored — a reminder bug is not a broken calendar.
   */
  mirrorCalendarWindow: (input: CalendarMirrorBatch) => Promise<CalendarMirrorCounts>;
  /** Wall-clock budget for one backfill page. Defaults to {@link BOOKED_BACKFILL_BUDGET_MS}. */
  backfillBudgetMs?: number;
  /** Injectable clock for that budget. Defaults to `Date.now`. */
  backfillNow?: () => number;
}

/** One connection's Gmail envelopes, as the alert path needs them. The access token is
 * the one this run refreshed, so the alert's on-demand body fetch does not have to
 * re-derive it (and no token leaves this module). */
export interface GmailAlertBatch {
  connection: ActiveConnectorConnection;
  accessToken: string;
  /** This run seeded the cursor — a first sync, or a re-seed after Gmail expired the
   * stored historyId — so its messages are the mailbox's existing 25. */
  seeding: boolean;
  /** Absent on the live incremental batch. `backfill` is historical booking-shaped
   * mail and must not be texted. */
  pass?: 'incremental' | 'backfill';
  envelopes: readonly GmailAlertEnvelope[];
}

/** One connection's calendar changes, as the alert path needs them. No access token: the
 * sentence is assembled from the fields the incremental list already returned, so this
 * path makes no further Google call. */
export interface CalendarAlertBatch {
  connection: ActiveConnectorConnection;
  /** This run started with no syncToken — a first sync, or the full resync Google forces
   * after a stale one — so its changes are the calendar's whole history. */
  seeding: boolean;
  changes: readonly CalendarChange[];
}

/** The upcoming window of one calendar, as the reminder mirror needs it. Separate from
 * the syncToken delta: an unchanged swim class that enters the horizon is not a "change",
 * and it is still something the parent expects to be reminded about. */
export interface CalendarMirrorBatch {
  connection: ActiveConnectorConnection;
  items: readonly Record<string, unknown>[];
  /** False when the list failed, was rate-limited, or stopped short of the last page.
   * A missing id is then unseen, not deleted. */
  trustWindow: boolean;
  now: Date;
}

/** What one connection's sync produced beyond its enqueues. Each list is empty for the
 * providers it does not belong to, and for a run that failed before the alert step. */
export interface SyncConnectionResult {
  emailAlerts: readonly EmailAlertResult[];
  calendarAlerts: readonly CalendarAlertOutcome[];
  /** Calendar items this run could not key at all, because Google sent no `id`. They have
   * no alert outcome — they never reached the alert path — and a drop with no number
   * beside it is a connector going blind without anyone being able to tell (rule #11). */
  calendarDroppedNoId: number;
  /** One outcome per Gmail envelope the travel detect pass looked at, INCLUDING the ones
   * it declined to look at. Its own list rather than a widening of `emailAlerts`: an
   * envelope has two independent answers — whether a text went about it, and whether a
   * trip was written down — and a bucket that means two things is the counter rule #11
   * exists to prevent. */
  travelDetections: readonly TravelDetectOutcome[];
}

const GONE = 410;
const NOT_FOUND = 404;
const RATE_LIMIT = 429;
const FORBIDDEN = 403;
/** Refresh a token this many ms before its stated expiry, so a sync doesn't start
 * with a token that expires mid-run. */
const EXPIRY_SKEW_MS = 60_000;
/** Bound the per-run pagination loop so a pathological Google response (e.g. a
 * self-referential nextPageToken) can't spin forever. */
const MAX_PAGES = 50;

interface ProviderResult {
  events: IngestedEventPayload[];
  nextMetadata: Record<string, unknown>;
  /** Gmail only: the same messages, unredacted, for the alert path. The triage stage
   * matches on the family's child NAMES, so it reads the envelope before
   * `redactEventPayload` masks them — which is why this rides alongside `events`
   * rather than being recovered from them. In-process only, never logged. */
  gmail?: { seeding: boolean; envelopes: GmailAlertEnvelope[] };
  /** Calendar only: the raw changes of this run, INCLUDING the cancelled items the ingest
   * drops. A tombstone is the single most useful thing the alert path says and the one
   * thing `events` structurally cannot carry, so it rides alongside. */
  calendar?: {
    seeding: boolean;
    changes: CalendarChange[];
    droppedNoId: number;
    windowItems: Record<string, unknown>[];
    trustWindow: boolean;
    windowAt: string;
  };
}

/**
 * Sync one active connector connection. Refreshes an expiring token, runs the
 * per-provider fetch+map, redacts, enqueues every item, then advances the cursor.
 * Any failure → markError, no cursor advance.
 */
export async function syncConnection(
  connection: ActiveConnectorConnection,
  deps: SyncDeps,
): Promise<SyncConnectionResult> {
  let emailAlerts: readonly EmailAlertResult[] = [];
  let calendarAlerts: readonly CalendarAlertOutcome[] = [];
  let calendarDroppedNoId = 0;
  let travelDetections: readonly TravelDetectOutcome[] = [];
  try {
    const accessToken = await ensureFreshToken(connection, deps);
    const result = await runProviderSync(connection, accessToken, deps.googleFetch);

    for (const event of result.events) {
      const redacted: IngestedEventPayload = {
        ...event,
        payload: redactEventPayload(event.payload, deps.childNames),
      };
      await deps.enqueue(redacted);
    }
    // Advance the cursor ONLY after the whole batch is enqueued (no partial cursor).
    await deps.saveCursor(connection.id, result.nextMetadata);
    // AFTER the cursor, deliberately: the ingest contract is the thing this sweep owes,
    // and a text is a bonus on top of it. Were the order reversed, a slow alert pass
    // that timed out would re-enqueue the whole batch on the next run.
    //
    // And behind its OWN boundary, for the same reason it runs last: the two halves fail
    // for unrelated reasons, and only one of those reasons is Google's. A missing enum
    // value, a timezone read that races a deletion — anything in Hale's alert path —
    // would otherwise reach the catch below, mark the CONNECTION errored and stop the
    // INGEST as well, so a bug in the bonus would silently end the contract.
    if (result.gmail) {
      const { seeding, envelopes } = result.gmail;
      try {
        emailAlerts = await deps.alertGmailEnvelopes({
          connection,
          accessToken,
          seeding,
          envelopes,
        });
      } catch (err) {
        // The class only: an alert-path rejection can carry a subject line (rule #1).
        console.error(
          {
            connectionId: connection.id,
            err: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'connector sync: the email alert pass threw - the mailbox is fine, the alert is not',
        );
        // THE TRIPLE, with a null booking and a null going: the alert pass threw, so
        // neither the booking decision nor the count was ever reached - which is a
        // different fact from a booking that was refused or a count that was below the
        // floor.
        emailAlerts = envelopes.map(() => ({
          alert: 'alert_failed' as const,
          booking: null,
          going: null,
        }));
      }
      // THE TRAVEL PASS, after the alert pass and behind its OWN boundary, for exactly the
      // reason the alert pass has one: a bug in Hale's travel path must not mark the
      // CONNECTION errored and stop the ingest. It runs second because the alert is the
      // older contract and this one spends model calls on what the alert already read.
      try {
        travelDetections = await deps.detectTravelBookings({
          connection,
          accessToken,
          seeding,
          envelopes,
        });
      } catch (err) {
        // The class only: a rejection from a body fetch or a model can carry a subject
        // line (rule #1).
        console.error(
          {
            connectionId: connection.id,
            err: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'connector sync: the travel detect pass threw - the mailbox is fine, the detection is not',
        );
        travelDetections = envelopes.map(() => 'detect_failed' as const);
      }
      const backfill = await backfillBookedMail(connection, accessToken, deps, result.nextMetadata);
      if (backfill.status === 'saved') emailAlerts = [...emailAlerts, ...backfill.alerts];
    }
    if (result.calendar) {
      const { seeding, changes } = result.calendar;
      calendarDroppedNoId = result.calendar.droppedNoId;
      try {
        const sweep = await deps.alertCalendarChanges({ connection, seeding, changes });
        // Flattened for the SUMMARY, which counts by name and never by position. The two
        // lists are kept apart inside the alert module because only the first one is
        // positional; a re-offer answers no change on this page (rule #11).
        calendarAlerts = [...sweep.changes, ...sweep.reoffers];
      } catch (err) {
        // The class only: an alert-path rejection can carry an event title (rule #1).
        console.error(
          {
            connectionId: connection.id,
            err: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'connector sync: the calendar alert pass threw - the calendar is fine, the alert is not',
        );
        calendarAlerts = changes.map(() => 'alert_failed' as const);
      }
      try {
        await deps.mirrorCalendarWindow({
          connection,
          items: result.calendar.windowItems,
          trustWindow: result.calendar.trustWindow,
          now: new Date(result.calendar.windowAt),
        });
      } catch (err) {
        console.error(
          {
            connectionId: connection.id,
            err: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'connector sync: the calendar mirror threw - the calendar is fine, the reminders are not',
        );
      }
    }
  } catch (err) {
    // The CODE is recorded, never the error's text — a Google response can carry a
    // token, a calendar title or an address (rule #1). Status/step only, in the row
    // and in one log line, so a stalled connector is diagnosable without prod access.
    const code = classifyConnectorError(err);
    console.error(
      { integrationId: connection.id, provider: connection.provider, code },
      'connector sync: failed',
    );
    await deps.markError(connection.id, code);
  }
  return { emailAlerts, calendarAlerts, calendarDroppedNoId, travelDetections };
}

/** Refresh + persist an expiring access token; returns the token to use for this
 * run. A still-valid token is used as-is (no refresh). */
async function ensureFreshToken(
  connection: ActiveConnectorConnection,
  deps: SyncDeps,
): Promise<string> {
  const { tokens } = connection;
  const expiringSoon =
    tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= Date.now();
  if (!expiringSoon) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) {
    // The refresh grant is what keeps a background sync alive once the first hour is
    // up. Handing Google the expired token instead would 401 on every run forever
    // under a reason nobody could read (rule #11): absence is an OUTCOME, not a
    // fallback to the dead value.
    throw new ConnectorSyncError('no_refresh_token');
  }
  let refreshed: OAuthTokens;
  try {
    refreshed = await deps.refreshTokens(tokens.refreshToken);
  } catch {
    // A rejected grant (the parent revoked access) needs a reconnect, not a retry —
    // it must not read the same as a failed calendar request.
    throw new ConnectorSyncError('token_refresh_failed');
  }
  // Google omits refresh_token on refresh — preserve the stored one.
  const merged: OAuthTokens = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
  };
  await deps.saveTokens(connection.id, merged);
  return merged.accessToken;
}

function runProviderSync(
  connection: ActiveConnectorConnection,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<ProviderResult> {
  switch (connection.provider) {
    case 'gcal':
      return syncCalendar(connection, accessToken, googleFetch);
    case 'gmail':
      return syncGmail(connection, accessToken, googleFetch);
    case 'gdrive':
      return syncDrive(connection, accessToken, googleFetch);
  }
}

async function getJson<T>(
  googleFetch: GoogleFetch,
  url: string,
  accessToken: string,
  opts?: { allowGone?: boolean; allowNotFound?: boolean; allowRateLimit?: boolean },
): Promise<{ status: number; data: T }> {
  const res = await googleFetch(url, accessToken);
  if (!res.ok) {
    // 410 is a signal ONLY where the caller opted in (Calendar events.list, whose
    // contract defines GONE = stale syncToken → full resync). Everywhere else a
    // 410 treated as empty success would advance the cursor to undefined and
    // trigger a re-seed double-enqueue — so it throws like any other non-ok.
    if (res.status === GONE && opts?.allowGone) return { status: GONE, data: {} as T };
    // 404 is a signal ONLY where the caller opted in. Gmail messages.get 404 is one
    // message deleted before the fetch; the first history.list page's 404 is an
    // expired historyId. Every other 404 still errors the whole connection.
    if (res.status === NOT_FOUND && opts?.allowNotFound)
      return { status: NOT_FOUND, data: {} as T };
    // 429 and 403 are a quota signal ONLY where the caller opted in (the reminder
    // window, and the booked-mail backfill). Treating them as a broken connection
    // would stop the ingest over a limit that clears on its own.
    if ((res.status === RATE_LIMIT || res.status === FORBIDDEN) && opts?.allowRateLimit)
      return { status: res.status, data: {} as T };
    throw new ConnectorSyncError(`google_${res.status}`);
  }
  return { status: res.status, data: (await res.json()) as T };
}

function ingested(
  provider: ConnectorProvider,
  familyId: string,
  payload: Record<string, unknown>,
): IngestedEventPayload {
  return { family_id: familyId, source: provider, payload, received_at: new Date().toISOString() };
}

// ── Calendar ─────────────────────────────────────────────────────────────────
// events.list with the stored syncToken (incremental), DRAINED to completion:
// Google returns nextPageToken for more pages and nextSyncToken ONLY on the final
// page — so every page must be pulled before the cursor advances, else later-page
// items are lost and the missing sync token forces a re-emit next run. On 410 GONE
// the syncToken is stale → drop it and full-resync (which returns a fresh token).
interface CalendarEventsResponse {
  items?: Array<Record<string, unknown>>;
  nextPageToken?: string;
  nextSyncToken?: string;
}

async function syncCalendar(
  connection: ActiveConnectorConnection,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<ProviderResult> {
  // showDeleted is TRUE, and the same base serves both the full sync and the
  // incremental. events.list documents the syncToken contract as "All events deleted
  // since the previous list request will always be in the result set and it is not
  // allowed to set showDeleted to False", and the sync guide as "Each list request
  // should use the same set of query parameters, including the initial request".
  // showDeleted=false is legal on a full sync and 400s on EVERY incremental — which
  // syncs a connection once at connect and never again. Every param here must be
  // legal WITH a syncToken, because this one string is what both requests send.
  const base =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&showDeleted=true';
  const startedWithToken = readString(connection.providerMetadata.syncToken);
  let syncToken = startedWithToken;
  let resynced = false;
  let pageToken: string | undefined;
  const items: Array<Record<string, unknown>> = [];
  let nextSyncToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let url = base;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    else if (syncToken) url += `&syncToken=${encodeURIComponent(syncToken)}`;

    const { status, data } = await getJson<CalendarEventsResponse>(googleFetch, url, accessToken, {
      allowGone: true,
    });
    if (status === GONE) {
      if (resynced) throw new ConnectorSyncError('google_410');
      // Stale syncToken → restart a full resync from scratch (drop the token/page).
      resynced = true;
      syncToken = undefined;
      pageToken = undefined;
      items.length = 0;
      continue;
    }
    for (const item of data.items ?? []) items.push(item);
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      continue;
    }
    nextSyncToken = data.nextSyncToken;
    break;
  }
  if (!nextSyncToken) {
    // No terminal token after draining the pages → do NOT advance the cursor.
    // Throwing marks the connection errored and leaves the old cursor, so nothing
    // is dropped or re-emitted; the next run retries from the last good point.
    throw new ConnectorSyncError('cursor_missing');
  }

  // Google forces the deleted events on us (above); Hale holds no event store to
  // delete from, so a tombstone is dropped rather than ingested as an appointment.
  const events = items
    .filter((item) => item.status !== 'cancelled')
    .map((item) =>
      ingested('gcal', connection.familyId, {
        id: item.id,
        summary: item.summary,
        description: item.description,
        location: item.location,
        start: item.start,
        end: item.end,
      }),
    );
  // ONE stamp for the whole run, so two items Google versioned with neither `updated` nor
  // an etag still key apart by their ids rather than by microseconds.
  const runStamp = new Date().toISOString();
  const changes: CalendarChange[] = [];
  let droppedNoId = 0;
  for (const item of items) {
    const change = calendarChangeOf(item, runStamp);
    if (change === null) droppedNoId += 1;
    else changes.push(change);
  }
  if (droppedNoId > 0) {
    // The COUNT only: an item this sweep could not key is still an item off a family's
    // calendar, and its fields do not belong in a log (rule #1).
    console.warn(
      { integrationId: connection.id, droppedNoId },
      'connector sync: calendar items with no id, dropped',
    );
  }
  // A second list, AFTER the delta, and on its own URL. syncToken forbids timeMin,
  // timeMax and orderBy, so the horizon cannot ride the incremental request. A failure
  // here must not fail the connection or throw away the cursor the delta just earned.
  const windowAt = new Date();
  const window = await listUpcomingCalendarWindow(
    googleFetch,
    accessToken,
    windowAt,
    connection.id,
  );
  return {
    events,
    nextMetadata: { syncToken: nextSyncToken },
    // A run that STARTED without a token saw the whole calendar, and so did the resync a
    // 410 forced — both are seeding, and neither may text about two hundred events the
    // parent put there themselves.
    calendar: {
      seeding: startedWithToken === undefined || resynced,
      changes,
      droppedNoId,
      windowItems: window.items,
      trustWindow: window.trustWindow,
      windowAt: windowAt.toISOString(),
    },
  };
}

/** How many pages of the upcoming window one sync will read. Two pages of 250 is
 * the horizon of a family calendar; a third page is a truncation, not a deletion. */
const WINDOW_PAGES = 2;

async function listUpcomingCalendarWindow(
  googleFetch: GoogleFetch,
  accessToken: string,
  now: Date,
  integrationId: string,
): Promise<{ items: Record<string, unknown>[]; trustWindow: boolean }> {
  const items: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < WINDOW_PAGES; page += 1) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
        timeMin: now.toISOString(),
        timeMax: new Date(now.getTime() + REMINDER_HORIZON_MS).toISOString(),
      });
      if (pageToken) params.set('pageToken', pageToken);
      const { status, data } = await getJson<CalendarEventsResponse>(
        googleFetch,
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        accessToken,
        { allowRateLimit: true },
      );
      if (status === RATE_LIMIT || status === FORBIDDEN) {
        console.info(
          { integrationId, status },
          'connector sync: calendar reminder window hit quota, mirrors left in place',
        );
        return { items: [], trustWindow: false };
      }
      for (const item of data.items ?? []) items.push(item);
      const next = readString(data.nextPageToken);
      if (next === undefined) return { items, trustWindow: true };
      pageToken = next;
    }
    console.info(
      { integrationId, seen: items.length },
      'connector sync: calendar reminder window truncated, mirrors not removed',
    );
    return { items, trustWindow: false };
  } catch (err) {
    console.info(
      {
        integrationId,
        code: err instanceof Error ? err.name : 'unknown',
        seen: items.length,
      },
      'connector sync: calendar reminder window unavailable, mirrors not removed',
    );
    return { items, trustWindow: false };
  }
}

/**
 * One events.list item as the alert path needs it, or nothing when Google sent no `id` —
 * the one field nothing can stand in for, and the counted drop above.
 *
 * Everything else has a documented fallback, because the items that carry least are the
 * cancellations, which are the most useful thing this feature says. events.list: a deleted
 * event "will only have the id field populated"; a cancelled instance of a recurring event
 * carries `recurringEventId` and `originalStartTime` instead of a `start`.
 */
function calendarChangeOf(item: Record<string, unknown>, runStamp: string): CalendarChange | null {
  const eventId = readString(item.id);
  if (eventId === undefined) return null;
  const status = readString(item.status);
  // A cancelled instance's original start IS its start: "the 8:15 on Friday" is the thing
  // that is not happening. On a MOVED instance `start` is present and wins, which is the
  // new time — the one the parent needs.
  const start = timePoint(item.start) ?? timePoint(item.originalStartTime) ?? {};
  return {
    eventId,
    // Google's own version where there is one, the etag where there is not (it changes
    // with the event, so a replay of the same page is the same key), and this run's clock
    // as the floor — a change nobody can version is still a change, and dropping it
    // silently is how the cancellation goes missing.
    updated: readString(item.updated) ?? readString(item.etag) ?? runStamp,
    // The series this item is an instance of. With singleEvents=true one edit to a weekly
    // class comes back as one item per instance, and this is the only field that says they
    // are the same edit — the alert path groups on it so six changes are one text.
    recurringEventId: readString(item.recurringEventId),
    status: status === 'cancelled' || status === 'tentative' ? status : 'confirmed',
    title: readString(item.summary),
    start,
    end: timePoint(item.end) ?? start,
    location: readString(item.location),
    selfOrganized: readSelf(item.organizer),
  };
}

/** A start/end Google actually placed in time, or nothing — so a caller can fall through
 * to the next field that might carry one. */
function timePoint(value: unknown): { dateTime?: string; date?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const point = value as { dateTime?: unknown; date?: unknown };
  const dateTime = readString(point.dateTime);
  const date = readString(point.date);
  return dateTime === undefined && date === undefined ? undefined : { dateTime, date };
}

function readSelf(organizer: unknown): boolean | undefined {
  if (typeof organizer !== 'object' || organizer === null) return undefined;
  return (organizer as { self?: unknown }).self === true ? true : undefined;
}

// ── Gmail ────────────────────────────────────────────────────────────────────
// First run (no historyId): messages.list → seed the historyId cursor. Incremental:
// history.list from the stored historyId → the ids of messages added since. A
// history.list 404 means that historyId has aged out of Gmail's window, and the
// run re-seeds exactly like a first run (seeding, so old mail is not texted).
// Either way we fetch each changed message's metadata (subject + snippet only).
// A messages.get 404 — deleted or trashed before the fetch — skips that one
// message; it does not error the connection.
interface GmailProfileResponse {
  historyId?: string;
}

interface GmailListResponse {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
  historyId?: string;
}

/** Receipts, invoices, confirmations, registrations from the last 90 days.
 * Waitlist and reminder mail that still matches is refused by falseBookingSignal
 * before a model call. */
export const BOOKED_BACKFILL_QUERY =
  'newer_than:90d (receipt OR invoice OR confirmation OR registration)';
interface GmailHistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
  nextPageToken?: string;
  historyId?: string;
}
interface GmailMessageResponse {
  id?: string;
  snippet?: string;
  /** Epoch milliseconds, as a string. Gmail returns it on `format=metadata` without
   * being asked, and it is the ONLY timestamp this sync has: the metadata GET requests
   * Subject and From alone, so there is no `Date` header to fall back to. */
  internalDate?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

type GmailHistoryDrain =
  | { stale: true }
  | { stale: false; messageIds: string[]; nextHistoryId: string };

async function syncGmail(
  connection: ActiveConnectorConnection,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<ProviderResult> {
  const startHistoryId = readString(connection.providerMetadata.historyId);
  // No stored cursor is the first-run seed. A stored one that Gmail 404s is the
  // same seed again: the history window moved on, and the sweep already retries
  // status=error rows, so this successful cursor write is what clears google_404.
  const history: GmailHistoryDrain = startHistoryId
    ? await drainGmailHistory(googleFetch, accessToken, startHistoryId)
    : { stale: true };
  const reseeded = startHistoryId !== undefined && history.stale;

  let messageIds: string[];
  let nextHistoryId: string;
  if (history.stale) {
    if (reseeded) {
      console.warn(
        { integrationId: connection.id },
        'connector sync: gmail historyId expired, re-seeding',
      );
    }
    const seeded = await seedGmailMailbox(googleFetch, accessToken);
    messageIds = seeded.messageIds;
    nextHistoryId = seeded.nextHistoryId;
  } else {
    messageIds = history.messageIds;
    nextHistoryId = history.nextHistoryId;
  }

  const { events, envelopes } = await readGmailMessageBatch(
    googleFetch,
    accessToken,
    connection,
    messageIds,
  );
  return {
    events,
    // Preserve bookedBackfill (and any other cursor key) across the history advance.
    // A fresh {historyId} object would wipe an in-progress backfill page.
    nextMetadata: { ...connection.providerMetadata, historyId: nextHistoryId },
    // A first run and a re-seed both saw mail that was already in the mailbox.
    // seeding is what keeps either from becoming a burst of texts.
    gmail: { seeding: startHistoryId === undefined || reseeded, envelopes },
  };
}

async function readGmailMessageBatch(
  googleFetch: GoogleFetch,
  accessToken: string,
  connection: { id: string; familyId: string },
  messageIds: readonly string[],
): Promise<{ events: IngestedEventPayload[]; envelopes: GmailAlertEnvelope[] }> {
  const events: IngestedEventPayload[] = [];
  const envelopes: GmailAlertEnvelope[] = [];
  let skippedNotFound = 0;
  for (const id of messageIds) {
    const { status, data } = await getJson<GmailMessageResponse>(
      googleFetch,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      accessToken,
      { allowNotFound: true },
    );
    if (status === NOT_FOUND) {
      // Gone between history.list and this fetch (deleted or trashed). The rest
      // of the batch is still real mail — one missing id must not park the mailbox.
      skippedNotFound += 1;
      continue;
    }
    const headers = data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name === 'Subject')?.value;
    const from = headers.find((h) => h.name === 'From')?.value;
    events.push(
      ingested('gmail', connection.familyId, {
        id: data.id,
        subject,
        from,
        snippet: data.snippet,
      }),
    );
    envelopes.push({
      messageId: id,
      subject: subject ?? '',
      from: from ?? '',
      snippet: data.snippet ?? '',
      receivedAt: epochMsToIso(data.internalDate),
    });
  }
  if (skippedNotFound > 0) {
    // The COUNT only: a message id is still a pointer at one family's mail (rule #1).
    console.warn(
      { integrationId: connection.id, skippedNotFound },
      'connector sync: gmail messages gone before fetch, skipped',
    );
  }
  return { events, envelopes };
}

interface BookedBackfillCursor {
  pageToken?: string;
  backfilledAt?: string;
  pendingIds?: string[];
}

export type BookedBackfillRun =
  | { status: 'off' }
  | { status: 'quota' }
  | { status: 'saved'; alerts: readonly EmailAlertResult[]; complete: boolean };

function readBookedBackfill(meta: Record<string, unknown>): BookedBackfillCursor {
  const raw = meta.bookedBackfill;
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as { pageToken?: unknown; backfilledAt?: unknown; pendingIds?: unknown };
  const pendingIds = Array.isArray(record.pendingIds)
    ? record.pendingIds
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, BOOKED_BACKFILL_MAX_PER_SWEEP)
    : [];
  return {
    pageToken: readString(record.pageToken),
    backfilledAt: readString(record.backfilledAt),
    ...(pendingIds.length > 0 ? { pendingIds } : {}),
  };
}

/**
 * One bounded page of booking-shaped mail, then stop. Silent: every envelope is
 * handed over with `pass: 'backfill'`, which records a booking and sends no text.
 *
 * `off` stamps nothing, so a flag that is not exactly `true` can still be turned
 * on later. `quota` stamps nothing either — the same page is listed again. A
 * `saved` cursor keeps every id this sweep did not finish (`pendingIds`) beside
 * the next list token, so a time budget cannot skip a message by advancing the page.
 */
export async function backfillBookedMail(
  connection: ActiveConnectorConnection,
  accessToken: string,
  deps: Pick<
    SyncDeps,
    'googleFetch' | 'alertGmailEnvelopes' | 'saveCursor' | 'backfillBudgetMs' | 'backfillNow'
  >,
  nextMetadata: Record<string, unknown>,
  options?: { budgetMs?: number; now?: () => number },
): Promise<BookedBackfillRun> {
  if (!bookedDetectionBackfillEnabled()) return { status: 'off' };
  if (!bookedDetectionEnabledFor(connection.familyId)) {
    // Do not stamp completion. Turning booked detection on later must still be
    // able to read the mailbox. Named so a sweep that listed nothing is readable.
    console.info(
      { integrationId: connection.id },
      'booked detection backfill: booked detection is off, page not started',
    );
    return { status: 'off' };
  }
  const prior = readBookedBackfill(connection.providerMetadata);
  if (prior.backfilledAt !== undefined) return { status: 'off' };

  const budgetMs = options?.budgetMs ?? deps.backfillBudgetMs ?? BOOKED_BACKFILL_BUDGET_MS;
  const clock = options?.now ?? deps.backfillNow ?? Date.now;
  const started = clock();

  let ids: string[];
  let nextPageToken: string | undefined;
  if (prior.pendingIds !== undefined && prior.pendingIds.length > 0) {
    ids = prior.pendingIds;
    nextPageToken = prior.pageToken;
  } else {
    try {
      const page = await listBookedBackfillPage(deps.googleFetch, accessToken, prior.pageToken);
      if (page.quota) {
        console.info(
          { integrationId: connection.id },
          'booked detection backfill: quota, page not saved',
        );
        return { status: 'quota' };
      }
      ids = page.messageIds;
      nextPageToken = page.nextPageToken;
    } catch (err) {
      console.error(
        {
          integrationId: connection.id,
          err: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'connector sync: booked backfill did not finish - the mailbox is fine, this page will be retried',
      );
      return { status: 'quota' };
    }
  }

  const alerts: EmailAlertResult[] = [];
  let stopAt = ids.length;
  for (let index = 0; index < ids.length; index += 1) {
    if (clock() - started >= budgetMs) {
      stopAt = index;
      break;
    }
    const id = ids[index];
    if (id === undefined) continue;
    let status: number;
    let data: GmailMessageResponse;
    try {
      const read = await getJson<GmailMessageResponse>(
        deps.googleFetch,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        accessToken,
        { allowNotFound: true, allowRateLimit: true },
      );
      status = read.status;
      data = read.data;
    } catch (err) {
      console.error(
        {
          integrationId: connection.id,
          err: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'connector sync: booked backfill did not finish - the mailbox is fine, this page will be retried',
      );
      stopAt = index;
      break;
    }
    if (status === RATE_LIMIT || status === FORBIDDEN) {
      console.info(
        { integrationId: connection.id, status },
        'booked detection backfill: quota, unread ids kept',
      );
      stopAt = index;
      break;
    }
    if (status === NOT_FOUND) continue;
    const headers = data.payload?.headers ?? [];
    const subject = headers.find((header) => header.name === 'Subject')?.value ?? '';
    const from = headers.find((header) => header.name === 'From')?.value ?? '';
    try {
      const one = await deps.alertGmailEnvelopes({
        connection,
        accessToken,
        seeding: false,
        pass: 'backfill',
        envelopes: [
          {
            messageId: id,
            subject,
            from,
            snippet: data.snippet ?? '',
            receivedAt: epochMsToIso(data.internalDate),
          },
        ],
      });
      alerts.push(...one);
    } catch (err) {
      console.error(
        {
          integrationId: connection.id,
          err: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'connector sync: booked backfill did not finish - the mailbox is fine, this page will be retried',
      );
      stopAt = index;
      break;
    }
  }

  const rest = ids.slice(stopAt);
  const bookedBackfill: BookedBackfillCursor =
    rest.length > 0
      ? { pendingIds: rest, ...(nextPageToken ? { pageToken: nextPageToken } : {}) }
      : nextPageToken
        ? { pageToken: nextPageToken }
        : { backfilledAt: new Date().toISOString() };
  await deps.saveCursor(connection.id, { ...nextMetadata, bookedBackfill });
  return { status: 'saved', alerts, complete: rest.length === 0 && nextPageToken === undefined };
}

async function listBookedBackfillPage(
  googleFetch: GoogleFetch,
  accessToken: string,
  pageToken: string | undefined,
): Promise<{ messageIds: string[]; nextPageToken?: string; quota: boolean }> {
  const params = new URLSearchParams({
    maxResults: String(BOOKED_BACKFILL_MAX_PER_SWEEP),
    q: BOOKED_BACKFILL_QUERY,
  });
  if (pageToken) params.set('pageToken', pageToken);
  const { status, data } = await getJson<GmailListResponse>(
    googleFetch,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    accessToken,
    { allowRateLimit: true },
  );
  if (status === RATE_LIMIT || status === FORBIDDEN) {
    return { messageIds: [], quota: true };
  }
  const messageIds: string[] = [];
  for (const message of data.messages ?? []) {
    if (message.id) messageIds.push(message.id);
  }
  return {
    messageIds: messageIds.slice(0, BOOKED_BACKFILL_MAX_PER_SWEEP),
    nextPageToken: readString(data.nextPageToken),
    quota: false,
  };
}

/** history.list from a stored historyId, drained to its terminal cursor. A 404 on
 * the FIRST page is Gmail's "startHistoryId is no longer in the history window"
 * and nothing else — a later page's 404 stays an error, same as any other status. */
async function drainGmailHistory(
  googleFetch: GoogleFetch,
  accessToken: string,
  startHistoryId: string,
): Promise<GmailHistoryDrain> {
  const messageIds: string[] = [];
  let nextHistoryId: string | undefined;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const { status, data } = await getJson<GmailHistoryResponse>(googleFetch, url, accessToken, {
      allowNotFound: pageToken === undefined,
    });
    if (status === NOT_FOUND) return { stale: true };
    for (const h of data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) messageIds.push(m.message.id);
      }
    }
    nextHistoryId = data.historyId ?? nextHistoryId;
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      continue;
    }
    break;
  }
  if (nextHistoryId === undefined) {
    // Mirrors the calendar/drive terminal-cursor guard: advancing the cursor to
    // {historyId: undefined} would make the next run re-seed and double-enqueue.
    throw new ConnectorSyncError('cursor_missing');
  }
  return { stale: false, messageIds, nextHistoryId };
}

/** First run, and the re-seed an expired historyId forces. getProfile is the
 * cursor source — messages.list does NOT return a historyId, so reading it there
 * yielded a {} cursor and re-seeded every run. The bounded page of recent
 * messages is the starting point; callers mark the run seeding so it is not texted. */
async function seedGmailMailbox(
  googleFetch: GoogleFetch,
  accessToken: string,
): Promise<{ messageIds: string[]; nextHistoryId: string }> {
  const { data: profile } = await getJson<GmailProfileResponse>(
    googleFetch,
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    accessToken,
  );
  const nextHistoryId = profile.historyId;
  const { data } = await getJson<GmailListResponse>(
    googleFetch,
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25',
    accessToken,
  );
  const messageIds: string[] = [];
  for (const m of data.messages ?? []) {
    if (m.id) messageIds.push(m.id);
  }
  if (nextHistoryId === undefined) {
    // No mailbox historyId means no safe incremental cursor to resume from — err
    // rather than persist {} and re-seed forever.
    throw new ConnectorSyncError('cursor_missing');
  }
  return { messageIds, nextHistoryId };
}

// ── Drive ────────────────────────────────────────────────────────────────────
// First run (no pageToken): getStartPageToken → seed the cursor. changes.list from
// the pageToken → changed files (metadata only: id/name/mimeType/modifiedTime).
interface DriveStartPageTokenResponse {
  startPageToken?: string;
}
interface DriveChangesResponse {
  changes?: Array<{ file?: Record<string, unknown> }>;
  newStartPageToken?: string;
  nextPageToken?: string;
}

async function syncDrive(
  connection: ActiveConnectorConnection,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<ProviderResult> {
  let seed = readString(connection.providerMetadata.pageToken);
  if (!seed) {
    const { data } = await getJson<DriveStartPageTokenResponse>(
      googleFetch,
      'https://www.googleapis.com/drive/v3/changes/startPageToken',
      accessToken,
    );
    seed = data.startPageToken;
  }
  if (!seed) {
    // No start token — nothing to sync yet; leave the cursor unset for next run.
    return { events: [], nextMetadata: connection.providerMetadata };
  }

  // Drain every changes page; newStartPageToken (the next cursor) arrives ONLY on
  // the final page, so advancing before then would drop later-page changes.
  let pageToken = seed;
  const files: Array<Record<string, unknown>> = [];
  let newStartPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await getJson<DriveChangesResponse>(
      googleFetch,
      `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&fields=changes(file(id,name,mimeType,modifiedTime)),nextPageToken,newStartPageToken`,
      accessToken,
    );
    for (const change of data.changes ?? []) {
      if (change.file) files.push(change.file);
    }
    if (data.nextPageToken) {
      pageToken = data.nextPageToken;
      continue;
    }
    newStartPageToken = data.newStartPageToken;
    break;
  }
  if (!newStartPageToken) {
    throw new ConnectorSyncError('cursor_missing');
  }

  const events = files.map((file) =>
    ingested('gdrive', connection.familyId, {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
    }),
  );
  return { events, nextMetadata: { pageToken: newStartPageToken } };
}

/** Gmail's `internalDate` as an ISO instant, or undefined when it is absent or not a
 * number — the extraction anchors relative dates ("this Saturday") on it, so a guessed
 * one would move an appointment rather than fail to mention it. */
function epochMsToIso(internalDate: string | undefined): string | undefined {
  if (internalDate === undefined) return undefined;
  const ms = Number(internalDate);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
