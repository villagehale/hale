import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';

/** One normalized error row — the shape the merged table renders. */
export interface AdminErrorRow {
  at: string;
  source: 'twilio' | 'message' | 'agent';
  code: string;
  summary: string;
}

const ERROR_WINDOW_DAYS = 30;
const PER_SOURCE_LIMIT = 50;

/**
 * The DB half of the errors table: failed sends + failed agent runs, newest
 * first. Twilio's own alert log merges in from the service client. No bodies,
 * no phone numbers — codes and template keys only (rule #1).
 */
export async function loadDbErrors(database: Database = defaultDb()): Promise<AdminErrorRow[]> {
  const m = schema.channelMessages;
  const failedMessages = await database
    .select({
      at: sql<string>`to_char(${m.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      code: sql<string>`coalesce(${m.errorCode}, 'failed')`,
      templateKey: m.templateKey,
      channel: sql<string>`${m.channel}::text`,
    })
    .from(m)
    .where(
      sql`${m.direction} = 'out' and ${m.status} = 'failed' and ${m.createdAt} >= now() - make_interval(days => ${ERROR_WINDOW_DAYS})`,
    )
    .orderBy(sql`${m.createdAt} desc`)
    .limit(PER_SOURCE_LIMIT);

  const r = schema.agentRuns;
  const failedRuns = await database
    .select({
      at: sql<string>`to_char(${r.startedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      status: sql<string>`${r.status}::text`,
      agentName: sql<string>`${r.agentName}::text`,
      modelUsed: r.modelUsed,
    })
    .from(r)
    .where(
      sql`${r.status} in ('failed', 'timed_out', 'killed_cost') and ${r.startedAt} >= now() - make_interval(days => ${ERROR_WINDOW_DAYS})`,
    )
    .orderBy(sql`${r.startedAt} desc`)
    .limit(PER_SOURCE_LIMIT);

  const rows: AdminErrorRow[] = [
    ...failedMessages.map(
      (row): AdminErrorRow => ({
        at: row.at,
        source: 'message',
        code: row.code,
        summary: `${row.channel} send failed${row.templateKey ? ` · ${row.templateKey}` : ''}`,
      }),
    ),
    ...failedRuns.map(
      (row): AdminErrorRow => ({
        at: row.at,
        source: 'agent',
        code: row.status,
        summary: `${row.agentName} · ${row.modelUsed}`,
      }),
    ),
  ];
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}
