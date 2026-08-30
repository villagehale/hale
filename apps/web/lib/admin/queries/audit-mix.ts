import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

/**
 * What Hale did, as audit_log action counts per Toronto-local day. The action
 * vocabulary is bounded (persisted action_taken keys), so day×action stays
 * small; the client sums a dial window and ranks.
 */
export interface AuditDayAction {
  day: string;
  action: string;
  count: number;
}

export async function loadAuditMix(database: Database = defaultDb()): Promise<AuditDayAction[]> {
  const a = schema.auditLog;
  const day = torontoDay(a.occurredAt);
  return database
    .select({
      day,
      action: a.actionTaken,
      count: sql<number>`count(*)::int`,
    })
    .from(a)
    .where(sql`${a.occurredAt} >= now() - make_interval(days => ${TREND_DAYS})`)
    .groupBy(day, a.actionTaken)
    .orderBy(day);
}
