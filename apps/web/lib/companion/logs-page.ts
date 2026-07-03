import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
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
 */
export async function readLogsPage(
  database: Database,
  familyId: string,
  opts: { childId?: string; before?: string; limit?: number } = {},
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
  if (opts.before) {
    filters.push(lt(schema.familyMemoryEpisodes.occurredAt, new Date(opts.before)));
  }

  const rows = await database
    .select({
      id: schema.familyMemoryEpisodes.id,
      childId: schema.familyMemoryEpisodes.childId,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      summary: schema.familyMemoryEpisodes.summary,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
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

  const logs = recentInternal.dropTeenEpisodes(rows, children).map((row) => ({
    id: row.id,
    childId: row.childId,
    episodeType: row.episodeType,
    summary: row.summary,
    occurredAt: row.occurredAt.toISOString(),
  }));

  return { logs, nextCursor };
}

/**
 * Request wrapper for the dedicated logs view. Mirrors loadRecentLogs: no
 * DATABASE_URL (preview) or no resolved family (unauthed / onboarding incomplete)
 * → an empty page. A genuine query failure once a DB exists surfaces (rule #8).
 */
export async function loadLogsPage(
  opts: { childId?: string; before?: string } = {},
): Promise<LogsPage> {
  if (!process.env.DATABASE_URL) return { logs: [], nextCursor: null };
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return { logs: [], nextCursor: null };
  return readLogsPage(database, familyId, opts);
}
