import { type SQL, sql } from 'drizzle-orm';
import { ADMIN_TIME_ZONE } from '../window';

/**
 * The Toronto-local day of a timestamptz column, as 'YYYY-MM-DD'. The timezone
 * is inlined as a LITERAL (it is a pinned constant, never input) so the SELECT
 * and GROUP BY render the identical expression — a parametrized `$1` makes
 * Postgres see two different expressions and reject the GROUP BY.
 */
const TZ = sql.raw(`'${ADMIN_TIME_ZONE}'`);

export function torontoDay(column: SQL | unknown): SQL<string> {
  return sql<string>`(${column} at time zone ${TZ})::date::text`;
}

/** Toronto midnight today, as a timestamptz expression. */
export function torontoTodayStart(): SQL {
  return sql`date_trunc('day', now() at time zone ${TZ}) at time zone ${TZ}`;
}
