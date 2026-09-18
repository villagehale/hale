import type { IngestedEventPayload } from '@hale/tools-contracts';
import { redactEventPayload } from '@hale/worker/redaction';
import type { CalendarAlertOutcome, CalendarChange } from './calendar-alert';
import type { EmailAlertOutcome, GmailAlertEnvelope } from './email-alert';
import type { ConnectorProvider } from './google-oauth';
import type { ActiveConnectorConnection } from './store';
import {
  type ConnectorErrorCode,
  ConnectorSyncError,
  classifyConnectorError,
} from './sync-error';
import type { OAuthTokens } from './token-vault';

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
  alertGmailEnvelopes: (input: GmailAlertBatch) => Promise<readonly EmailAlertOutcome[]>;
  /**
   * The same contract for the calendar's raw changes (lib/integrations/calendar-alert.ts),
   * and non-nullable for the same reason: "nothing is wired to alert" is a decision a
   * caller makes out loud, never by withholding a port (rule #11).
   */
  alertCalendarChanges: (input: CalendarAlertBatch) => Promise<readonly CalendarAlertOutcome[]>;
}

/** One connection's Gmail envelopes, as the alert path needs them. The access token is
 * the one this run refreshed, so the alert's on-demand body fetch does not have to
 * re-derive it (and no token leaves this module). */
export interface GmailAlertBatch {
  connection: ActiveConnectorConnection;
  accessToken: string;
  /** This run had no stored historyId, so its messages are the mailbox's existing 25. */
  seeding: boolean;
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

/** What one connection's sync produced beyond its enqueues. Each list is empty for the
 * providers it does not belong to, and for a run that failed before the alert step. */
export interface SyncConnectionResult {
  emailAlerts: readonly EmailAlertOutcome[];
  calendarAlerts: readonly CalendarAlertOutcome[];
  /** Calendar items this run could not key at all, because Google sent no `id`. They have
   * no alert outcome — they never reached the alert path — and a drop with no number
   * beside it is a connector going blind without anyone being able to tell (rule #11). */
  calendarDroppedNoId: number;
}

const GONE = 410;
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
  calendar?: { seeding: boolean; changes: CalendarChange[]; droppedNoId: number };
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
  let emailAlerts: readonly EmailAlertOutcome[] = [];
  let calendarAlerts: readonly CalendarAlertOutcome[] = [];
  let calendarDroppedNoId = 0;
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
        emailAlerts = envelopes.map(() => 'alert_failed' as const);
      }
    }
    if (result.calendar) {
      const { seeding, changes } = result.calendar;
      calendarDroppedNoId = result.calendar.droppedNoId;
      try {
        calendarAlerts = await deps.alertCalendarChanges({ connection, seeding, changes });
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
  return { emailAlerts, calendarAlerts, calendarDroppedNoId };
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
  const merged: OAuthTokens = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokens.refreshToken };
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
  opts?: { allowGone?: boolean },
): Promise<{ status: number; data: T }> {
  const res = await googleFetch(url, accessToken);
  if (!res.ok) {
    // 410 is a signal ONLY where the caller opted in (Calendar events.list, whose
    // contract defines GONE = stale syncToken → full resync). Everywhere else a
    // 410 treated as empty success would advance the cursor to undefined and
    // trigger a re-seed double-enqueue — so it throws like any other non-ok.
    if (res.status === GONE && opts?.allowGone) return { status: GONE, data: {} as T };
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

    const { status, data } = await getJson<CalendarEventsResponse>(googleFetch, url, accessToken, { allowGone: true });
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
    },
  };
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
// history.list from the stored historyId → the ids of messages added since. Either
// way we fetch each changed message's metadata (subject header + snippet only).
interface GmailProfileResponse {
  historyId?: string;
}

interface GmailListResponse {
  messages?: Array<{ id?: string }>;
  historyId?: string;
}
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

async function syncGmail(
  connection: ActiveConnectorConnection,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<ProviderResult> {
  const startHistoryId = readString(connection.providerMetadata.historyId);
  const messageIds: string[] = [];
  let nextHistoryId: string | undefined;

  if (startHistoryId) {
    // Drain every history page before advancing historyId — otherwise messages on
    // later pages are dropped AND the cursor jumps past them permanently.
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let url = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const { data } = await getJson<GmailHistoryResponse>(googleFetch, url, accessToken);
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
  } else {
    // First run: seed the historyId cursor from getProfile (the mailbox's current
    // historyId — messages.list does NOT return one, so reading it there yielded a
    // {} cursor and re-seeded every run) and emit a bounded page of recent messages
    // as the starting point.
    const { data: profile } = await getJson<GmailProfileResponse>(
      googleFetch,
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      accessToken,
    );
    nextHistoryId = profile.historyId;
    const { data } = await getJson<GmailListResponse>(
      googleFetch,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25',
      accessToken,
    );
    for (const m of data.messages ?? []) {
      if (m.id) messageIds.push(m.id);
    }
    if (nextHistoryId === undefined) {
      // No mailbox historyId means no safe incremental cursor to resume from — err
      // rather than persist {} and re-seed forever.
      throw new ConnectorSyncError('cursor_missing');
    }
  }

  const events: IngestedEventPayload[] = [];
  const envelopes: GmailAlertEnvelope[] = [];
  for (const id of messageIds) {
    const { data } = await getJson<GmailMessageResponse>(
      googleFetch,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      accessToken,
    );
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
  return {
    events,
    nextMetadata: { historyId: nextHistoryId },
    gmail: { seeding: startHistoryId === undefined, envelopes },
  };
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
