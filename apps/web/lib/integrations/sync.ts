import type { IngestedEventPayload } from '@hale/tools-contracts';
import { redactEventPayload } from '@hale/worker/redaction';
import type { ConnectorProvider } from './google-oauth';
import type { ActiveConnectorConnection } from './store';
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
  /** Mark the connection errored on failure (cursor left untouched). */
  markError: (id: string) => Promise<void>;
  /** Refresh an expired access token (Google refresh_token grant). Returns a token
   * set whose refreshToken may be absent — Google omits it on refresh. */
  refreshTokens: (refreshToken: string) => Promise<OAuthTokens>;
  /** Persist a refreshed token set (re-encrypted) by connection id. */
  saveTokens: (id: string, tokens: OAuthTokens) => Promise<void>;
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
}

/**
 * Sync one active connector connection. Refreshes an expiring token, runs the
 * per-provider fetch+map, redacts, enqueues every item, then advances the cursor.
 * Any failure → markError, no cursor advance.
 */
export async function syncConnection(
  connection: ActiveConnectorConnection,
  deps: SyncDeps,
): Promise<void> {
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
  } catch {
    // No error detail is logged — a Google response can carry token/PII (rule #1).
    await deps.markError(connection.id);
  }
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
  if (!expiringSoon || !tokens.refreshToken) {
    return tokens.accessToken;
  }
  const refreshed = await deps.refreshTokens(tokens.refreshToken);
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
    throw new Error(`google api ${res.status}`);
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
  const base =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&showDeleted=false';
  let syncToken = readString(connection.providerMetadata.syncToken);
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
      if (resynced) throw new Error('calendar: syncToken gone during full resync');
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
    throw new Error('calendar: no nextSyncToken on the final page');
  }

  const events = items.map((item) =>
    ingested('gcal', connection.familyId, {
      id: item.id,
      summary: item.summary,
      description: item.description,
      location: item.location,
      start: item.start,
      end: item.end,
    }),
  );
  return { events, nextMetadata: { syncToken: nextSyncToken } };
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
      throw new Error('gmail history drained without a terminal historyId');
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
      throw new Error('gmail getProfile returned no historyId');
    }
  }

  const events: IngestedEventPayload[] = [];
  for (const id of messageIds) {
    const { data } = await getJson<GmailMessageResponse>(
      googleFetch,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      accessToken,
    );
    const headers = data.payload?.headers ?? [];
    events.push(
      ingested('gmail', connection.familyId, {
        id: data.id,
        subject: headers.find((h) => h.name === 'Subject')?.value,
        from: headers.find((h) => h.name === 'From')?.value,
        snippet: data.snippet,
      }),
    );
  }
  return { events, nextMetadata: { historyId: nextHistoryId } };
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
    throw new Error('drive: no newStartPageToken on the final page');
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

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
