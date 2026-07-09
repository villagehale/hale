import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type RegisteredTool, type ToolCard, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { refreshAccessToken } from '~/lib/integrations/google-oauth';
import { getConnectionTokens, saveConnectionTokensById } from '~/lib/integrations/store';
import type { OAuthTokens } from '~/lib/integrations/token-vault';

/**
 * The Ask Hale agent's CONNECTOR read tools — a read-only window onto the acting
 * parent's own connected Google Drive / Calendar, so Hale can answer "is that
 * permission form in my Drive?" or "am I free Saturday morning?" honestly.
 *
 * Boundaries these tools hold, by construction:
 *  - READ-ONLY. Drive `files.list` + Calendar `events.list` only; no create/update.
 *  - METADATA ONLY (rule #1). Drive surfaces name/mimeType/modifiedTime/webViewLink
 *    — never file CONTENT. Calendar surfaces summary/start/end/location — never the
 *    attendee list or description. The Google field mask is the enforcement: the
 *    tool asks Google for exactly these fields, so nothing else is ever fetched.
 *  - FAMILY + USER SCOPED FROM THE SESSION. The connection is looked up by
 *    (ctx.familyId, ctx.actor) — the signed-in parent's own token. The model NEVER
 *    supplies a familyId/userId: the input schema carries only a search `query`
 *    (Drive) or nothing (Calendar), so a forged scope in tool args is impossible.
 *  - NO TOKENS ESCAPE. The decrypted token is used to call Google and then dropped;
 *    it is never part of the tool's return value or the streamed card (rule #1).
 *  - HONEST WHEN NOT CONNECTED. No connection → a typed `not_connected` result the
 *    model relays plainly ("connect Google Drive in Settings"), never an error.
 *
 * All Google I/O + the token vault are injected (defaulting to the real impls) so
 * the shaping, field masks, caps, refresh, and scoping are unit-testable without a
 * live Google or DB.
 */

/** Bearer-GET onto the Google REST API, normalized so tests inject a fake. Mirrors
 * `googleGetFetch` in lib/cron/connector-sync.ts (same shape the sync sweep uses). */
export type ConnectorFetch = (
  url: string,
  accessToken: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The injectable seam: load the acting parent's token, refresh it if expiring, and
 * call Google. Defaults wire the real token vault + OAuth refresh + fetch. */
export interface ConnectorToolDeps {
  getTokens: (
    database: Database,
    familyId: string,
    userId: string,
    provider: 'gdrive' | 'gcal',
  ) => Promise<OAuthTokens | null>;
  refreshTokens: (refreshToken: string) => Promise<OAuthTokens>;
  saveTokens: (database: Database, familyId: string, userId: string, provider: 'gdrive' | 'gcal', tokens: OAuthTokens) => Promise<void>;
  fetch: ConnectorFetch;
  /** Injectable clock so the calendar window is deterministic in tests. */
  now: () => Date;
}

const realGoogleFetch: ConnectorFetch = async (url, accessToken) => {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export const defaultConnectorToolDeps: ConnectorToolDeps = {
  getTokens: (database, familyId, userId, provider) =>
    getConnectionTokens(database, familyId, userId, provider),
  refreshTokens: (refreshToken) => refreshAccessToken(refreshToken),
  saveTokens: async (database, familyId, userId, provider, tokens) => {
    // Persist by locating the row through the same (family,user,provider) scope the
    // load used; the refreshed blob replaces the stored one, cursor untouched.
    await saveConnectionTokensByScope(database, familyId, userId, provider, tokens);
  },
  fetch: realGoogleFetch,
  now: () => new Date(),
};

/** Bound the calendar window + result counts (cost discipline — every Google call
 * is a metered request, and a huge agenda would bloat the model context). */
const CALENDAR_WINDOW_DAYS = 7;
const CALENDAR_MAX_RESULTS = 10;
const DRIVE_MAX_RESULTS = 5;
/** Refresh a token this many ms before its stated expiry (mirrors sync.ts). */
const EXPIRY_SKEW_MS = 60_000;

/** A tool result the model reads AND (for the client) the whitelisted card. The
 * `card` is a closed union carrying ONLY display-safe fields — never raw payload,
 * never a token. It rides the existing tool-result stream event (see agent.ts). */
type ConnectorToolResult =
  | { status: 'ok'; card: ToolCard }
  | { status: 'not_connected'; card: ToolCard };

/** Refresh an expiring access token; returns the token to use for this call. A
 * still-valid token is used as-is. Mirrors `ensureFreshToken` in sync.ts: Google
 * omits the refresh_token on refresh, so the stored one is preserved. */
async function freshAccessToken(
  database: Database,
  familyId: string,
  userId: string,
  provider: 'gdrive' | 'gcal',
  tokens: OAuthTokens,
  deps: ConnectorToolDeps,
): Promise<string> {
  const expiringSoon =
    tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= deps.now().getTime();
  if (!expiringSoon || !tokens.refreshToken) {
    return tokens.accessToken;
  }
  const refreshed = await deps.refreshTokens(tokens.refreshToken);
  const merged: OAuthTokens = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
  };
  await deps.saveTokens(database, familyId, userId, provider, merged);
  return merged.accessToken;
}

interface DriveFile {
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  webViewLink?: unknown;
}
interface DriveListResponse {
  files?: DriveFile[];
}

/** Google Drive's `q` requires single quotes around the term escaped. We only ever
 * pass a plain name-contains search, so escape the apostrophes and wrap. */
function driveNameQuery(query: string): string {
  const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `name contains '${escaped}' and trashed = false`;
}

interface CalendarTime {
  dateTime?: unknown;
  date?: unknown;
}
interface CalendarEvent {
  summary?: unknown;
  location?: unknown;
  start?: CalendarTime;
  end?: CalendarTime;
}
interface CalendarListResponse {
  items?: CalendarEvent[];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** An all-day event carries `date`; a timed event carries `dateTime`. Surface
 * whichever is present as the ISO-ish string the card renders. */
function timeString(time: CalendarTime | undefined): string {
  return asString(time?.dateTime) ?? asString(time?.date) ?? '';
}

export function buildConnectorTools(
  database: Database,
  deps: ConnectorToolDeps = defaultConnectorToolDeps,
): RegisteredTool[] {
  const driveSearch = defineTool<{ query: string }, ConnectorToolResult>({
    name: 'drive_search',
    description:
      "Search the SIGNED-IN PARENT's connected Google Drive by file name and return the top matches as name + type + last-modified + a link to open. Read-only, file NAMES and links only — never file contents. If Drive isn't connected, say so and point them to Settings.",
    inputSchema: z.object({ query: z.string().min(1).max(256) }),
    handler: async (input, ctx): Promise<ConnectorToolResult> => {
      const tokens = await deps.getTokens(database, ctx.familyId, ctx.actor, 'gdrive');
      if (!tokens) {
        return { status: 'not_connected', card: { kind: 'not_connected', provider: 'gdrive' } };
      }
      const accessToken = await freshAccessToken(
        database,
        ctx.familyId,
        ctx.actor,
        'gdrive',
        tokens,
        deps,
      );
      const driveQuery = encodeURIComponent(driveNameQuery(input.query));
      const url = `https://www.googleapis.com/drive/v3/files?q=${driveQuery}&pageSize=${DRIVE_MAX_RESULTS}&orderBy=modifiedTime%20desc&fields=files(name,mimeType,modifiedTime,webViewLink)`;
      const res = await deps.fetch(url, accessToken);
      if (!res.ok) {
        throw new Error(`drive_search: google api ${res.status}`);
      }
      const data = (await res.json()) as DriveListResponse;
      const files = (data.files ?? [])
        .slice(0, DRIVE_MAX_RESULTS)
        .map((f) => ({
          name: asString(f.name) ?? 'Untitled',
          mimeType: asString(f.mimeType) ?? 'application/octet-stream',
          modifiedTime: asString(f.modifiedTime) ?? '',
          webViewLink: asString(f.webViewLink) ?? '',
        }))
        .filter((f) => f.webViewLink.length > 0);
      return { status: 'ok', card: { kind: 'drive', files } };
    },
  });

  const calendarLookup = defineTool<Record<string, never>, ConnectorToolResult>({
    name: 'calendar_lookup',
    description:
      "Look at the SIGNED-IN PARENT's connected Google Calendar for the next 7 days and return upcoming events as day + time + title (+ location). Read-only, event titles/times only. Use it for questions like 'am I free Saturday morning?'. If Calendar isn't connected, say so and point them to Settings.",
    inputSchema: z.object({}),
    handler: async (_input, ctx): Promise<ConnectorToolResult> => {
      const tokens = await deps.getTokens(database, ctx.familyId, ctx.actor, 'gcal');
      if (!tokens) {
        return { status: 'not_connected', card: { kind: 'not_connected', provider: 'gcal' } };
      }
      const accessToken = await freshAccessToken(
        database,
        ctx.familyId,
        ctx.actor,
        'gcal',
        tokens,
        deps,
      );
      const now = deps.now();
      const timeMax = new Date(now.getTime() + CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const timeMin = encodeURIComponent(now.toISOString());
      const timeMaxParam = encodeURIComponent(timeMax.toISOString());
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMaxParam}&singleEvents=true&orderBy=startTime&maxResults=${CALENDAR_MAX_RESULTS}&fields=items(summary,location,start(date,dateTime),end(date,dateTime))`;
      const res = await deps.fetch(url, accessToken);
      if (!res.ok) {
        throw new Error(`calendar_lookup: google api ${res.status}`);
      }
      const data = (await res.json()) as CalendarListResponse;
      const events = (data.items ?? [])
        .slice(0, CALENDAR_MAX_RESULTS)
        .map((e) => {
          const location = asString(e.location);
          return {
            title: asString(e.summary) ?? '(busy)',
            start: timeString(e.start),
            end: timeString(e.end),
            ...(location ? { location } : {}),
          };
        })
        .filter((e) => e.start.length > 0);
      return { status: 'ok', card: { kind: 'calendar', events } };
    },
  });

  return [driveSearch, calendarLookup];
}

/** Persist a refreshed token set by (family,user,provider) scope, re-encrypted.
 * Locates the row id through the same scope the load used, then defers to the
 * store's by-id writer so the encryption boundary stays in one place. */
async function saveConnectionTokensByScope(
  database: Database,
  familyId: string,
  userId: string,
  provider: 'gdrive' | 'gcal',
  tokens: OAuthTokens,
): Promise<void> {
  const rows = await database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        eq(schema.integrations.userId, userId),
        eq(schema.integrations.provider, provider),
        eq(schema.integrations.status, 'active'),
      ),
    )
    .limit(1);
  const id = rows[0]?.id;
  if (!id) return;
  await saveConnectionTokensById(database, id, tokens);
}
