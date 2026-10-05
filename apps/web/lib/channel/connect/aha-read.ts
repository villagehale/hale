/**
 * VIL-418. The facts Hale may mention the moment a calendar or mailbox connects.
 *
 * Code reads a bounded window and hands it to the model. It does not decide
 * which item is useful, and it does not write the sentence. A cancelled event
 * is not an upcoming event. Everything else in the window is data, including a
 * block titled Busy: the model decides whether it is worth saying.
 */

import { zonedMidnight } from '~/lib/memory/period';

export const AHA_TIME_ZONE = 'America/Toronto';
export const AHA_ITEM_LIMIT = 8;
/** Far enough to name a registration that is not tomorrow, short enough for one text. */
export const AHA_CALENDAR_HORIZON_MS = 21 * 24 * 60 * 60 * 1000;

const TITLE_MAX = 120;
const SNIPPET_MAX = 160;

/**
 * `none_for_kids`: the read worked and the source had items, but none of them
 * was about the kids (aha-kids.ts). Not "empty": the model must not say the
 * source had nothing in it, and must not name a parent item instead.
 */
export type AhaRead = 'ok' | 'empty' | 'failed' | 'withheld' | 'none_for_kids';

export interface AhaCalendarFact {
  title: string;
  /** ISO instant, or YYYY-MM-DD when `allDay` is true. */
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  declined: boolean;
}

export interface AhaEmailFact {
  subject: string;
  fromName: string | null;
  /** ISO instant from Gmail internalDate, when Google sent one. */
  receivedAt: string | null;
  snippet: string | null;
}

export interface AhaOverlap {
  earlier: string;
  later: string;
}

export interface AhaSnapshot {
  provider: 'gcal' | 'gmail';
  read: AhaRead;
  calendar: AhaCalendarFact[];
  email: AhaEmailFact[];
  overlaps: AhaOverlap[];
}

export interface AhaFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type AhaGoogleFetch = (url: string, accessToken: string) => Promise<AhaFetchResponse>;

export function failedAha(provider: 'gcal' | 'gmail'): AhaSnapshot {
  return { provider, read: 'failed', calendar: [], email: [], overlaps: [] };
}

export function emptyAha(provider: 'gcal' | 'gmail'): AhaSnapshot {
  return { provider, read: 'empty', calendar: [], email: [], overlaps: [] };
}

/**
 * A 13+ child's mail is not a parent-facing aha (rule #1). Calendar facts are
 * the parent's own events and stay. Withheld is not "empty": the model must
 * not say the mailbox had nothing in it.
 */
export function withholdTeenMail(snapshot: AhaSnapshot): AhaSnapshot {
  if (snapshot.provider !== 'gmail') return snapshot;
  if (snapshot.read === 'failed') return { ...snapshot, email: [] };
  return { ...snapshot, email: [], read: 'withheld' };
}

export function ahaWhenLabel(
  start: string,
  allDay: boolean,
  timeZone: string,
  language: 'en' | 'fr',
): string {
  const locale = language === 'fr' ? 'fr-CA' : 'en-CA';
  if (allDay) {
    const [year, month, day] = start.split('-').map((part) => Number(part));
    if (!year || !month || !day) return start;
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }
  const instant = new Date(start);
  if (Number.isNaN(instant.getTime())) return start;
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(instant);
}

/** "9:00", the clock token the fact lint recognizes. Null for an all-day date. */
export function ahaClockLabel(start: string, timeZone: string): string | null {
  const instant = new Date(start);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(instant);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  if (!hour || !minute) return null;
  return `${hour}:${minute}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function cleanTitle(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.includes('@')) return null;
  return text.length <= TITLE_MAX ? text : text.slice(0, TITLE_MAX).trimEnd();
}

function cleanLocation(value: string): string | null {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.includes('@') || /https?:\/\//i.test(text)) return null;
  return text.length <= 80 ? text : text.slice(0, 80).trimEnd();
}

const EMAIL_ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_TOKEN = /https?:\/\/\S+/gi;
const PHONE_TOKEN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g;

export function stripContactTokens(value: string): string {
  return value
    .replace(EMAIL_ADDRESS, ' ')
    .replace(URL_TOKEN, ' ')
    .replace(PHONE_TOKEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSnippet(value: string): string | null {
  const text = stripContactTokens(value);
  if (text.length === 0) return null;
  return text.length <= SNIPPET_MAX ? text : text.slice(0, SNIPPET_MAX).trimEnd();
}

function displayName(from: string): string | null {
  const named = /^([^<]+)</.exec(from);
  const raw = named?.[1] ?? '';
  const text = raw.replace(/^["']+|["']+$/g, '').trim();
  if (!text || text.includes('@')) return null;
  return text.length <= 80 ? text : text.slice(0, 80).trimEnd();
}

function selfDeclined(item: Record<string, unknown>): boolean {
  if (!Array.isArray(item.attendees)) return false;
  for (const attendee of item.attendees) {
    if (typeof attendee !== 'object' || attendee === null) continue;
    const row = attendee as { self?: unknown; responseStatus?: unknown };
    if (row.self === true && row.responseStatus === 'declined') return true;
  }
  return false;
}

function torontoDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: AHA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

interface Timed {
  startMs: number;
  endMs: number;
}

function factInterval(fact: AhaCalendarFact): Timed | null {
  if (fact.allDay) {
    const start = zonedMidnight(fact.start, AHA_TIME_ZONE);
    if (Number.isNaN(start.getTime())) return null;
    const endKey = fact.end && fact.end !== fact.start ? fact.end : null;
    const end = endKey
      ? zonedMidnight(endKey, AHA_TIME_ZONE)
      : new Date(start.getTime() + 24 * 60 * 60 * 1000);
    if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) return null;
    return { startMs: start.getTime(), endMs: end.getTime() };
  }
  const startMs = Date.parse(fact.start);
  if (Number.isNaN(startMs)) return null;
  if (!fact.end) return null;
  const endMs = Date.parse(fact.end);
  if (Number.isNaN(endMs) || endMs <= startMs) return null;
  return { startMs, endMs };
}

/** Two real intervals overlap. A missing end is not given a guessed duration. */
export function calendarOverlaps(facts: readonly AhaCalendarFact[]): AhaOverlap[] {
  const spans = facts.flatMap((fact) => {
    const span = factInterval(fact);
    return span ? [{ fact, span }] : [];
  });
  const overlaps: AhaOverlap[] = [];
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const left = spans[i];
      const right = spans[j];
      if (!left || !right) continue;
      const earlier = left.span.startMs <= right.span.startMs ? left : right;
      const later = earlier === left ? right : left;
      if (earlier.span.startMs < later.span.endMs && later.span.startMs < earlier.span.endMs) {
        overlaps.push({ earlier: earlier.fact.title, later: later.fact.title });
      }
    }
  }
  return overlaps.slice(0, 4);
}

/** Upcoming items from one events.list page. Past and cancelled rows are not upcoming. */
export function calendarFactsFromItems(items: readonly unknown[], now: Date): AhaCalendarFact[] {
  const today = torontoDay(now);
  const facts: AhaCalendarFact[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (readString(item.status) === 'cancelled') continue;
    const title = cleanTitle(readString(item.summary) ?? '');
    if (!title) continue;
    const start = timePoint(item.start);
    if (!start) continue;
    const end = timePoint(item.end);
    const allDay = start.date !== undefined && start.dateTime === undefined;
    if (allDay) {
      const day = start.date ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today) continue;
      facts.push({
        title,
        start: day,
        end: end?.date && /^\d{4}-\d{2}-\d{2}$/.test(end.date) ? end.date : null,
        allDay: true,
        location: cleanLocation(readString(item.location) ?? ''),
        declined: selfDeclined(item),
      });
      continue;
    }
    const startsAt = new Date(start.dateTime ?? '');
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= now.getTime()) continue;
    const endsAt = end?.dateTime ? new Date(end.dateTime) : null;
    facts.push({
      title,
      start: startsAt.toISOString(),
      end: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt.toISOString() : null,
      allDay: false,
      location: cleanLocation(readString(item.location) ?? ''),
      declined: selfDeclined(item),
    });
  }
  facts.sort((a, b) => a.start.localeCompare(b.start));
  return facts.slice(0, AHA_ITEM_LIMIT);
}

function timePoint(value: unknown): { dateTime?: string; date?: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const point = value as { dateTime?: unknown; date?: unknown };
  const dateTime = readString(point.dateTime);
  const date = readString(point.date);
  return dateTime === undefined && date === undefined ? undefined : { dateTime, date };
}

export function emailFactsFromMessages(messages: readonly unknown[]): AhaEmailFact[] {
  const facts: AhaEmailFact[] = [];
  for (const raw of messages) {
    if (typeof raw !== 'object' || raw === null) continue;
    const message = raw as {
      snippet?: unknown;
      internalDate?: unknown;
      payload?: { headers?: Array<{ name?: unknown; value?: unknown }> };
    };
    const headers = message.payload?.headers ?? [];
    const header = (name: string): string => {
      const found = headers.find((row) => readString(row.name)?.toLowerCase() === name);
      return readString(found?.value) ?? '';
    };
    const subject = cleanTitle(header('subject'));
    if (!subject) continue;
    const internal = readString(message.internalDate);
    const receivedMs = internal ? Number(internal) : Number.NaN;
    facts.push({
      subject,
      fromName: displayName(header('from')),
      receivedAt: Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : null,
      snippet: cleanSnippet(readString(message.snippet) ?? ''),
    });
  }
  return facts.slice(0, AHA_ITEM_LIMIT);
}

function snapshot(
  provider: 'gcal' | 'gmail',
  calendar: AhaCalendarFact[],
  email: AhaEmailFact[],
): AhaSnapshot {
  const populated = provider === 'gcal' ? calendar.length > 0 : email.length > 0;
  return {
    provider,
    read: populated ? 'ok' : 'empty',
    calendar,
    email,
    overlaps: calendarOverlaps(calendar),
  };
}

async function getJson(
  googleFetch: AhaGoogleFetch,
  url: string,
  accessToken: string,
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const res = await googleFetch(url, accessToken);
    if (!res.ok) return { ok: false };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false };
  }
}

/** The connect-time read, with teen mail withheld when the caller says so. */
export async function loadConnectedAha(input: {
  provider: 'gcal' | 'gmail';
  accessToken: string;
  now: Date;
  googleFetch: AhaGoogleFetch;
  hasTeen: boolean;
}): Promise<AhaSnapshot> {
  const snapshot = await readConnectedAha(input);
  return input.hasTeen ? withholdTeenMail(snapshot) : snapshot;
}

/**
 * One bounded read of the source that just connected. Never throws: a failed
 * read is a named snapshot, and the receipt still has to be writable.
 */
export async function readConnectedAha(input: {
  provider: 'gcal' | 'gmail';
  accessToken: string;
  now: Date;
  googleFetch: AhaGoogleFetch;
}): Promise<AhaSnapshot> {
  const { provider, accessToken, now, googleFetch } = input;
  if (!accessToken) return failedAha(provider);
  try {
    if (provider === 'gcal') return await readCalendar(accessToken, now, googleFetch);
    return await readMailbox(accessToken, googleFetch);
  } catch {
    return failedAha(provider);
  }
}

async function readCalendar(
  accessToken: string,
  now: Date,
  googleFetch: AhaGoogleFetch,
): Promise<AhaSnapshot> {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(AHA_ITEM_LIMIT),
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + AHA_CALENDAR_HORIZON_MS).toISOString(),
  });
  const listed = await getJson(
    googleFetch,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    accessToken,
  );
  if (!listed.ok) return failedAha('gcal');
  const items = Array.isArray((listed.data as { items?: unknown }).items)
    ? ((listed.data as { items: unknown[] }).items ?? [])
    : [];
  return snapshot('gcal', calendarFactsFromItems(items, now), []);
}

async function readMailbox(accessToken: string, googleFetch: AhaGoogleFetch): Promise<AhaSnapshot> {
  const listed = await getJson(
    googleFetch,
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${AHA_ITEM_LIMIT}`,
    accessToken,
  );
  if (!listed.ok) return failedAha('gmail');
  const ids = messageIds(listed.data);
  if (ids.length === 0) return emptyAha('gmail');
  const fetched = await Promise.all(
    ids.map((id) =>
      getJson(
        googleFetch,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        accessToken,
      ),
    ),
  );
  const messages = fetched.flatMap((row) => (row.ok ? [row.data] : []));
  if (messages.length === 0) return failedAha('gmail');
  return snapshot('gmail', [], emailFactsFromMessages(messages));
}

function messageIds(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return [];
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const ids: string[] = [];
  for (const row of messages) {
    if (typeof row !== 'object' || row === null) continue;
    const id = readString((row as { id?: unknown }).id);
    if (id) ids.push(id);
  }
  return ids.slice(0, AHA_ITEM_LIMIT);
}
