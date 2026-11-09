import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq, inArray } from 'drizzle-orm';
import { senderLabel } from '../integrations/sender-label';

/**
 * VIL-429 · where Hale saw a fact it took from a connector. An email is named by its
 * sender (display name or bare domain, never the address) and the day it arrived; a
 * calendar event by its title and its day. Nothing else of the item is carried: no
 * subject, no body, no snippet.
 */
export type FactSourceLabel =
  | { kind: 'email'; from: string; on: Date }
  | { kind: 'calendar'; title: string; on: Date };

/**
 * A connector fact with a null label came from Gmail or Calendar, but this reader may not
 * be told where: the item is a 13+ child's, its sender or title cannot be read, the
 * mailbox may be another adult's, or the reader is a group thread. Such a fact is not
 * shown at all: a connector fact never renders without its source.
 */
export type FactSource = { connector: true; label: FactSourceLabel | null } | { connector: false };

const CONNECTOR_SOURCES = new Set(['gmail', 'gcal', 'google_calendar']);
const TITLE_CHARS = 60;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function calendarStart(payload: Record<string, unknown>): Date | null {
  const start = payload.start;
  const raw =
    typeof start === 'string'
      ? start
      : start && typeof start === 'object'
        ? ((start as { dateTime?: unknown; date?: unknown }).dateTime ??
          (start as { date?: unknown }).date)
        : null;
  if (typeof raw !== 'string') return null;
  // An all-day date has no zone: noon UTC is that same day in every zone a family is in.
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00.000Z` : raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The label one event row yields, or null when it cannot be built from the row. */
export function labelForEvent(event: {
  source: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
}): FactSourceLabel | null {
  if (event.source === 'gmail') {
    const header = text(event.payload.sender) ?? text(event.payload.from);
    const from = header ? text(senderLabel(header)) : text(event.payload.sender_org);
    return from ? { kind: 'email', from, on: event.receivedAt } : null;
  }
  const title = text(event.payload.summary) ?? text(event.payload.title);
  if (!title) return null;
  return {
    kind: 'calendar',
    title: title.length <= TITLE_CHARS ? title : `${title.slice(0, TITLE_CHARS - 1)}…`,
    on: calendarStart(event.payload) ?? event.receivedAt,
  };
}

/**
 * True only when every Gmail connection the family has ever kept is this reader's own,
 * so the email a fact came from was in their mailbox. Any other adult's connection, or
 * one with no adult on it, makes the mailbox unknown.
 */
async function mailboxIsReaders(
  database: Database,
  familyId: string,
  readerUserId: string | null,
): Promise<boolean> {
  if (readerUserId === null) return false;
  const rows = await database
    .select({ userId: schema.integrations.userId })
    .from(schema.integrations)
    .where(
      and(eq(schema.integrations.familyId, familyId), eq(schema.integrations.provider, 'gmail')),
    );
  return rows.length > 0 && rows.every((row) => row.userId === readerUserId);
}

/**
 * Where each fact came from, keyed by the fact's `sourceEventId`. A row that is not a
 * connector item is `connector: false`: the fact renders as it always did. A connector
 * item yields its label, or null when this reader may not see it.
 *
 * `inGroup`: a group thread never hears a source (VIL-429), so every connector item is
 * withheld there.
 */
export async function loadFactSources(
  database: Database,
  input: {
    familyId: string;
    readerUserId: string | null;
    inGroup: boolean;
    now: Date;
    sourceEventIds: readonly (string | null)[];
  },
): Promise<Map<string, FactSource>> {
  const ids = [...new Set(input.sourceEventIds.filter((id): id is string => id !== null))];
  const sources = new Map<string, FactSource>();
  if (ids.length === 0) return sources;
  const rows = await database
    .select({
      id: schema.events.id,
      source: schema.events.source,
      payload: schema.events.payload,
      receivedAt: schema.events.receivedAt,
      childId: schema.events.childId,
      teenContent: schema.events.teenContent,
    })
    .from(schema.events)
    .where(and(eq(schema.events.familyId, input.familyId), inArray(schema.events.id, ids)));
  const connectorRows = rows.filter((row) => CONNECTOR_SOURCES.has(row.source));
  const [teens, ownMailbox] = await Promise.all([
    teenChildIds(database, input.familyId, input.now),
    connectorRows.some((row) => row.source === 'gmail')
      ? mailboxIsReaders(database, input.familyId, input.readerUserId)
      : Promise.resolve(false),
  ]);
  for (const row of rows) {
    if (!CONNECTOR_SOURCES.has(row.source)) {
      sources.set(row.id, { connector: false });
      continue;
    }
    const hidden =
      input.inGroup ||
      row.teenContent ||
      (row.childId !== null && teens.has(row.childId)) ||
      (row.source === 'gmail' && !ownMailbox);
    sources.set(row.id, { connector: true, label: hidden ? null : labelForEvent(row) });
  }
  // A fact that names an item Hale no longer holds (a disconnect erased it) cannot say
  // where it came from, so it is withheld like any other unlabelled connector fact.
  for (const id of ids) {
    if (!sources.has(id)) sources.set(id, { connector: true, label: null });
  }
  return sources;
}

async function teenChildIds(database: Database, familyId: string, now: Date): Promise<Set<string>> {
  const rows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(
    rows.filter((row) => deriveStage(row.dateOfBirth, now) === 'teenager').map((row) => row.id),
  );
}

/** The day, as `YYYY-MM-DD` in the reader's zone: data for a model to word. */
export function labelDay(on: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(on);
}

/** The column's own default when no reader is named: a day is still a day in UTC. */
const NO_READER_ZONE = 'UTC';

export async function readerTimeZone(
  database: Database,
  userId: string | null | undefined,
): Promise<string> {
  if (!userId) return NO_READER_ZONE;
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) throw new Error('readerTimeZone: no user row');
  return row.timezone;
}
