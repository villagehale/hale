/**
 * Google Calendar event writes (VIL-93).
 *
 * Primary calendar only. `sendUpdates=none` so Google does not email guests —
 * the placement's iTIP invite is the family's notice. Callers pass an access
 * token they already decided was allowed to write. This module does not read
 * flags or scopes, and it never logs a response body (a body can carry a title).
 */

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface GoogleCalendarEventInput {
  summary: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date | null;
}

export interface GoogleFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type GoogleCalendarFetch = (url: string, init: RequestInit) => Promise<GoogleFetchResponse>;

export class GoogleCalendarApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`google calendar write failed: ${status}`);
    this.name = 'GoogleCalendarApiError';
    this.status = status;
  }
}

function eventResource(input: GoogleCalendarEventInput): Record<string, unknown> {
  const end = input.endsAt ?? new Date(input.startsAt.getTime() + ONE_HOUR_MS);
  return {
    summary: input.summary,
    ...(input.location ? { location: input.location } : {}),
    start: { dateTime: input.startsAt.toISOString() },
    end: { dateTime: end.toISOString() },
  };
}

function eventUrl(eventId?: string): string {
  const path = eventId ? `${EVENTS_URL}/${encodeURIComponent(eventId)}` : EVENTS_URL;
  return `${path}?sendUpdates=none`;
}

async function callGoogle(
  fetchImpl: GoogleCalendarFetch,
  accessToken: string,
  url: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

function idFrom(json: unknown): string {
  const id = (json as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new GoogleCalendarApiError(200);
  return id;
}

export async function createGoogleCalendarEvent(
  accessToken: string,
  input: GoogleCalendarEventInput,
  fetchImpl: GoogleCalendarFetch = fetch,
): Promise<{ googleEventId: string }> {
  const url = eventUrl();
  const { status, json } = await callGoogle(
    fetchImpl,
    accessToken,
    url,
    'POST',
    eventResource(input),
  );
  if (status !== 200 && status !== 201) throw new GoogleCalendarApiError(status);
  return { googleEventId: idFrom(json) };
}

export async function updateGoogleCalendarEvent(
  accessToken: string,
  googleEventId: string,
  input: GoogleCalendarEventInput,
  fetchImpl: GoogleCalendarFetch = fetch,
): Promise<{ googleEventId: string }> {
  const url = eventUrl(googleEventId);
  const { status, json } = await callGoogle(
    fetchImpl,
    accessToken,
    url,
    'PATCH',
    eventResource(input),
  );
  if (status !== 200) throw new GoogleCalendarApiError(status);
  const id = (json as { id?: unknown } | null)?.id;
  return { googleEventId: typeof id === 'string' && id ? id : googleEventId };
}

/** 404 and 410 mean the event is already gone. That is the state a cancel wanted. */
export async function deleteGoogleCalendarEvent(
  accessToken: string,
  googleEventId: string,
  fetchImpl: GoogleCalendarFetch = fetch,
): Promise<{ googleEventId: string; alreadyGone: boolean }> {
  const url = eventUrl(googleEventId);
  const { status } = await callGoogle(fetchImpl, accessToken, url, 'DELETE');
  if (status === 404 || status === 410) return { googleEventId, alreadyGone: true };
  if (status !== 200 && status !== 204) throw new GoogleCalendarApiError(status);
  return { googleEventId, alreadyGone: false };
}
