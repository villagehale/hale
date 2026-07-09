import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { FEED_KINDS, MEASURE_KINDS } from './log-types.js';
import {
  type LogsPage,
  nextCursorFrom,
  PAGE_LIMIT,
} from './logs-view.js';
import { _internal as recentInternal } from './recent-logs.js';

/**
 * The dedicated, scalable logs view — distinct from the 8-row companion widget.
 * Reads a keyset-paginated page of the family's quick-logs (newest first),
 * optionally filtered to one child, with the same teen redaction as the widget
 * (rule #1, dropTeenEpisodes) and soft-deleted rows excluded. The pure grouping +
 * cursor helpers live in logs-view.ts (client-safe); this module is the DB read.
 *
 * `Database` + `familyId` are injected into readLogsPage so the redaction/filter
 * is unit-testable without the server-only auth chain; loadLogsPage is the request
 * wrapper (mirrors loadRecentLogs' degradation).
 */

export { PAGE_LIMIT, groupLogsByDay, nextCursorFrom } from './logs-view.js';
export type { LogView, LogsPage, LogDayGroup } from './logs-view.js';

/**
 * Reads one keyset page of live (not soft-deleted) episodes, newest first,
 * optionally scoped to one child, with teen redaction applied (rule #1). `before`
 * is the occurredAt cursor from the previous page (exclusive); omit for the first
 * page. `childId` narrows to a single child; omit for the whole family.
 * `episodeType` narrows to one kind (e.g. 'measurement' for Growth); omit for all.
 */
export async function readLogsPage(
  database: Database,
  familyId: string,
  requestingUserId: string | null,
  opts: { childId?: string; episodeType?: string; before?: string; limit?: number } = {},
): Promise<LogsPage> {
  const limit = opts.limit ?? PAGE_LIMIT;

  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const filters = [
    eq(schema.familyMemoryEpisodes.familyId, familyId),
    isNull(schema.familyMemoryEpisodes.deletedAt),
  ];
  if (opts.childId) {
    filters.push(eq(schema.familyMemoryEpisodes.childId, opts.childId));
  }
  // A single episode type (e.g. Growth reads only 'measurement') keeps a rare-event
  // series off the shared page budget: measurements never compete with the flood of
  // feeds/naps for the 30 rows, so old readings don't silently fall off the page.
  if (opts.episodeType) {
    filters.push(eq(schema.familyMemoryEpisodes.episodeType, opts.episodeType));
  }
  if (opts.before) {
    filters.push(lt(schema.familyMemoryEpisodes.occurredAt, new Date(opts.before)));
  }

  const rows = await database
    .select({
      id: schema.familyMemoryEpisodes.id,
      childId: schema.familyMemoryEpisodes.childId,
      authoredBy: schema.familyMemoryEpisodes.authoredBy,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      summary: schema.familyMemoryEpisodes.summary,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
      payload: schema.familyMemoryEpisodes.payload,
    })
    .from(schema.familyMemoryEpisodes)
    .where(and(...filters))
    .orderBy(desc(schema.familyMemoryEpisodes.occurredAt))
    .limit(limit);

  // Cursor advances by the RAW fetch (pre-redaction) so a fully-redacted page
  // doesn't stall pagination.
  const nextCursor = nextCursorFrom(
    rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() })),
    limit,
  );

  // Redaction runs on the raw rows FIRST (rule #1, shared read path); the numeric
  // lift happens only on rows that survived it — a redacted row never reaches
  // liftNumerics, so no teen number can leak. Only numbers are lifted, never the
  // raw payload / notes.
  const logs = recentInternal
    .dropTeenEpisodes(rows, children, requestingUserId)
    .map((row) => ({
      id: row.id,
      childId: row.childId,
      episodeType: row.episodeType,
      summary: row.summary,
      occurredAt: row.occurredAt.toISOString(),
      ...liftNumerics(row.payload),
    }));

  return { logs, nextCursor };
}

/**
 * Lifts ONLY the structured numerics a client charts (nap minutes, feed ml + kind)
 * out of the episode payload — never the raw payload or free-text note (rule #1).
 * Each field is emitted only when it is the expected type, so a malformed payload
 * yields no field rather than a wrong-typed value.
 */
function liftNumerics(payload: Record<string, unknown>): {
  durationMin?: number;
  amountMl?: number;
  feedKind?: string;
  measureKind?: string;
  value?: number;
  unit?: string;
} {
  const out: {
    durationMin?: number;
    amountMl?: number;
    feedKind?: string;
    measureKind?: string;
    value?: number;
    unit?: string;
  } = {};
  if (typeof payload.durationMin === 'number') out.durationMin = payload.durationMin;
  if (typeof payload.amountMl === 'number') out.amountMl = payload.amountMl;
  // Enum-gated, not any string: episodes have a second writer (the worker's
  // free-shape payloads), so an unexpected feedKind value must not surface
  // verbatim to clients.
  if (
    typeof payload.feedKind === 'string' &&
    (FEED_KINDS as readonly string[]).includes(payload.feedKind)
  ) {
    out.feedKind = payload.feedKind;
  }
  // A measurement lifts three numerics/tokens: the ENUM-GATED measureKind (same
  // second-writer discipline as feedKind), the numeric value, and the unit — but
  // only together, so a partial/free-shape payload never surfaces a half-measurement.
  if (
    typeof payload.measureKind === 'string' &&
    (MEASURE_KINDS as readonly string[]).includes(payload.measureKind) &&
    typeof payload.value === 'number' &&
    typeof payload.unit === 'string'
  ) {
    out.measureKind = payload.measureKind;
    out.value = payload.value;
    out.unit = payload.unit;
  }
  return out;
}

/**
 * Request wrapper for the dedicated logs view. Mirrors loadRecentLogs: no
 * DATABASE_URL (preview) or no resolved family (unauthed / onboarding incomplete)
 * → an empty page. A genuine query failure once a DB exists surfaces (rule #8).
 */
export async function loadLogsPage(
  opts: { childId?: string; episodeType?: string; before?: string } = {},
): Promise<LogsPage> {
  if (!process.env.DATABASE_URL) return { logs: [], nextCursor: null };
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return { logs: [], nextCursor: null };
  const requestingUserId = await currentUserId(database);
  return readLogsPage(database, familyId, requestingUserId, opts);
}
