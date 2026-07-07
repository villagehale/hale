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
): Promise<{ status: number; data: T }> {
  const res = await googleFetch(url, accessToken);
  if (!res.ok) {
    // 410 is surfaced to the caller (Calendar full-resync); every other non-ok
    // throws → the connection is marked errored and the cursor is not advanced.
    if (res.status === GONE) return { status: GONE, data: {} as T };
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
// events.list with the stored syncToken (incremental). On 410 GONE the syncToken
// is stale (Google expired it) → drop it and do a full resync, which returns a
// fresh nextSyncToken.
interface CalendarEventsResponse {
  items?: Array<Record<string, unknown>>;
  nextSyncToken?: string;
}

async function syncCalendar(
  connection: ActiveConnectorConnection,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<ProviderResult> {
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&showDeleted=false';
  const syncToken = readString(connection.providerMetadata.syncToken);

  const url = syncToken ? `${base}&syncToken=${encodeURIComponent(syncToken)}` : base;
  let { status, data } = await getJson<CalendarEventsResponse>(googleFetch, url, accessToken);
  if (status === GONE) {
    // Stale syncToken → full resync (no syncToken).
    ({ data } = await getJson<CalendarEventsResponse>(googleFetch, base, accessToken));
  }

  const events = (data.items ?? []).map((item) =>
    ingested('gcal', connection.familyId, {
      id: item.id,
      summary: item.summary,
      description: item.description,
      location: item.location,
      start: item.start,
      end: item.end,
    }),
  );
  return { events, nextMetadata: { syncToken: data.nextSyncToken } };
}

// ── Gmail ────────────────────────────────────────────────────────────────────
// First run (no historyId): messages.list → seed the historyId cursor. Incremental:
// history.list from the stored historyId → the ids of messages added since. Either
// way we fetch each changed message's metadata (subject header + snippet only).
interface GmailListResponse {
  messages?: Array<{ id?: string }>;
  historyId?: string;
}
interface GmailHistoryResponse {
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
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
  let messageIds: string[];
  let nextHistoryId: string | undefined;

  if (startHistoryId) {
    const { data } = await getJson<GmailHistoryResponse>(
      googleFetch,
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded`,
      accessToken,
    );
    messageIds = (data.history ?? []).flatMap((h) =>
      (h.messagesAdded ?? []).map((m) => m.message?.id).filter((id): id is string => Boolean(id)),
    );
    nextHistoryId = data.historyId;
  } else {
    const { data } = await getJson<GmailListResponse>(
      googleFetch,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25',
      accessToken,
    );
    messageIds = (data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    nextHistoryId = data.historyId;
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
  let pageToken = readString(connection.providerMetadata.pageToken);
  if (!pageToken) {
    const { data } = await getJson<DriveStartPageTokenResponse>(
      googleFetch,
      'https://www.googleapis.com/drive/v3/changes/startPageToken',
      accessToken,
    );
    pageToken = data.startPageToken;
  }
  if (!pageToken) {
    // No start token — nothing to sync yet; leave the cursor unset for next run.
    return { events: [], nextMetadata: connection.providerMetadata };
  }

  const { data } = await getJson<DriveChangesResponse>(
    googleFetch,
    `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&fields=changes(file(id,name,mimeType,modifiedTime)),newStartPageToken`,
    accessToken,
  );
  const events = (data.changes ?? [])
    .map((c) => c.file)
    .filter((f): f is Record<string, unknown> => Boolean(f))
    .map((file) =>
      ingested('gdrive', connection.familyId, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
      }),
    );
  return { events, nextMetadata: { pageToken: data.newStartPageToken ?? data.nextPageToken ?? pageToken } };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
