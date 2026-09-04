import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { CONSUMED_SEND_STATUSES } from '~/lib/channel/ledger';
import { db as defaultDb } from '~/lib/db';
import { torontoTodayStart } from './day';

/** The navy band — today's line, one glance. */
export interface PulseData {
  /** Distinct parents who texted IN since Toronto midnight. The hero numeral. */
  familiesToday: number;
  /** One tick per hour of inbound texts, last 24h, oldest first. Always 24 slots. */
  hourly: { hourIso: string; count: number }[];
  msgsInToday: number;
  msgsOutToday: number;
  newFamiliesToday: number;
  /** Failed sends + failed/timed-out/cost-killed agent runs since Toronto
   * midnight — the same failure vocabulary as the Operations tab. */
  failuresToday: number;
  spendTodayUsd: number;
  /** When these numbers were computed — the band's "data as of" stamp. */
  asOf: string;
}

const todayStart = torontoTodayStart();

/** The statuses that mean "the provider was contacted" (ledger.ts) — a suppression
 * is a message Hale chose NOT to send and must not read as outbound traffic. */
const REAL_SEND_STATUSES = sql.join(
  CONSUMED_SEND_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

export async function loadPulse(database: Database = defaultDb()): Promise<PulseData> {
  const m = schema.channelMessages;

  const [msg] = await database
    .select({
      familiesToday: sql<number>`count(distinct ${m.parentUserId}) filter (where ${m.direction} = 'in')::int`,
      msgsInToday: sql<number>`count(*) filter (where ${m.direction} = 'in')::int`,
      msgsOutToday: sql<number>`count(*) filter (where ${m.direction} = 'out' and ${m.status} in (${REAL_SEND_STATUSES}))::int`,
      failedToday: sql<number>`count(*) filter (where ${m.direction} = 'out' and ${m.status} = 'failed')::int`,
    })
    .from(m)
    .where(sql`${m.createdAt} >= ${todayStart}`);

  const hourRows = await database
    .select({
      hourIso: sql<string>`to_char(date_trunc('hour', ${m.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      count: sql<number>`count(*)::int`,
    })
    .from(m)
    .where(sql`${m.direction} = 'in' and ${m.createdAt} >= now() - interval '24 hours'`)
    .groupBy(sql`date_trunc('hour', ${m.createdAt})`);

  const [fam] = await database
    .select({ newFamiliesToday: sql<number>`count(*)::int` })
    .from(schema.families)
    .where(sql`${schema.families.createdAt} >= ${todayStart}`);

  const [runs] = await database
    .select({
      spendTodayUsd: sql<number>`coalesce(sum(${schema.agentRuns.costUsd}), 0)::float8`,
      failedRunsToday: sql<number>`count(*) filter (where ${schema.agentRuns.status} in ('failed', 'timed_out', 'killed_cost'))::int`,
    })
    .from(schema.agentRuns)
    .where(sql`${schema.agentRuns.startedAt} >= ${todayStart}`);

  // 24 fixed slots ending this hour, zero-filled — the strip never changes width.
  const byHour = new Map(hourRows.map((r) => [r.hourIso, r.count]));
  const thisHour = new Date();
  thisHour.setUTCMinutes(0, 0, 0);
  const hourly: { hourIso: string; count: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const hourIso = new Date(thisHour.getTime() - i * 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    hourly.push({ hourIso, count: byHour.get(hourIso) ?? 0 });
  }

  return {
    familiesToday: msg?.familiesToday ?? 0,
    hourly,
    msgsInToday: msg?.msgsInToday ?? 0,
    msgsOutToday: msg?.msgsOutToday ?? 0,
    newFamiliesToday: fam?.newFamiliesToday ?? 0,
    failuresToday: (msg?.failedToday ?? 0) + (runs?.failedRunsToday ?? 0),
    spendTodayUsd: runs?.spendTodayUsd ?? 0,
    asOf: new Date().toISOString(),
  };
}
