import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

export interface SpendDay {
  day: string;
  costUsd: number;
  runs: number;
  failedRuns: number;
  /** prompt_cache_hit true / non-null — the window's hit % is Σhits / Σknown. */
  cacheHits: number;
  cacheKnown: number;
  /** That day's p50 latency; the window stat is the median of daily p50s. */
  p50LatencyMs: number | null;
}

export interface AgentSpendData {
  /** Per Toronto-local day. Sparse — fillWindow() zero-fills. */
  days: SpendDay[];
  /** Runs by agent over the whole trend window (a mix, not a dial-sliced trend). */
  byAgent: { agent: string; runs: number }[];
}

export async function loadAgentSpend(database: Database = defaultDb()): Promise<AgentSpendData> {
  const r = schema.agentRuns;
  const day = torontoDay(r.startedAt);
  const since = sql`${r.startedAt} >= now() - make_interval(days => ${TREND_DAYS})`;

  const days = await database
    .select({
      day,
      costUsd: sql<number>`coalesce(sum(${r.costUsd}), 0)::float8`,
      runs: sql<number>`count(*)::int`,
      failedRuns: sql<number>`count(*) filter (where ${r.status} = 'failed')::int`,
      cacheHits: sql<number>`count(*) filter (where ${r.promptCacheHit})::int`,
      cacheKnown: sql<number>`count(*) filter (where ${r.promptCacheHit} is not null)::int`,
      p50LatencyMs: sql<number | null>`(percentile_cont(0.5) within group (order by ${r.latencyMs}))::float8`,
    })
    .from(r)
    .where(since)
    .groupBy(day)
    .orderBy(day);

  const byAgent = await database
    .select({
      agent: sql<string>`${r.agentName}::text`,
      runs: sql<number>`count(*)::int`,
    })
    .from(r)
    .where(since)
    .groupBy(r.agentName)
    .orderBy(sql`count(*) desc`);

  return { days, byAgent };
}
