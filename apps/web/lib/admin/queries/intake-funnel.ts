import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

/**
 * The text-intake funnel, per Toronto-local day of session creation. COUNTS
 * ONLY — the session's encrypted payload (child names, transcript) is never
 * read here (rule #1).
 *
 * engaged: the machine advanced past the greeting ('awaiting_details' is the
 * state a session is born into) or a targeted follow-up was asked — either way
 * the parent replied at least once.
 */
export interface IntakeDay {
  day: string;
  started: number;
  engaged: number;
  provisioned: number;
  dropped: number;
}

export interface IntakeFunnelData {
  days: IntakeDay[];
  /** Where starts came from (QR venue codes), per Toronto-local day — the
   * client slices the dial window, then ranks; ranking is a display concern
   * once rows are day-grain. */
  sources: IntakeSourceDay[];
}

export interface IntakeSourceDay {
  day: string;
  code: string;
  started: number;
  provisioned: number;
}

export async function loadIntakeFunnel(database: Database = defaultDb()): Promise<IntakeFunnelData> {
  const s = schema.smsIntakeSessions;
  const day = torontoDay(s.createdAt);
  const since = sql`${s.createdAt} >= now() - make_interval(days => ${TREND_DAYS})`;

  const days = await database
    .select({
      day,
      started: sql<number>`count(*)::int`,
      engaged: sql<number>`count(*) filter (where ${s.state} <> 'awaiting_details' or ${s.followUpCount} > 0)::int`,
      provisioned: sql<number>`count(*) filter (where ${s.familyId} is not null)::int`,
      dropped: sql<number>`count(*) filter (where ${s.closedAt} is not null and ${s.familyId} is null)::int`,
    })
    .from(s)
    .where(since)
    .groupBy(day)
    .orderBy(day);

  const code = sql<string>`coalesce(${s.sourceCode}, 'direct')`;
  const sources = await database
    .select({
      day,
      code,
      started: sql<number>`count(*)::int`,
      provisioned: sql<number>`count(*) filter (where ${s.familyId} is not null)::int`,
    })
    .from(s)
    .where(since)
    .groupBy(day, code)
    .orderBy(day, code);

  return { days, sources };
}
