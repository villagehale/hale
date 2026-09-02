import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

export interface GrowthDay {
  day: string;
  families: number;
}

export interface GrowthData {
  /** New families per Toronto-local day. Sparse — fillWindow() zero-fills. */
  days: GrowthDay[];
  /** Current tier mix across ALL families (a stock, not a windowed flow). */
  tiers: { tier: string; count: number }[];
  foundingCount: number;
  total: number;
}

export async function loadGrowth(database: Database = defaultDb()): Promise<GrowthData> {
  const day = torontoDay(schema.families.createdAt);
  const days = await database
    .select({ day, families: sql<number>`count(*)::int` })
    .from(schema.families)
    .where(sql`${schema.families.createdAt} >= now() - make_interval(days => ${TREND_DAYS})`)
    .groupBy(day)
    .orderBy(day);

  const tiers = await database
    .select({
      tier: sql<string>`${schema.families.planTier}::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.families)
    .groupBy(schema.families.planTier);

  const [totals] = await database
    .select({
      total: sql<number>`count(*)::int`,
      foundingCount: sql<number>`count(*) filter (where ${schema.families.foundingNumber} is not null)::int`,
    })
    .from(schema.families);

  return {
    days,
    tiers,
    foundingCount: totals?.foundingCount ?? 0,
    total: totals?.total ?? 0,
  };
}
