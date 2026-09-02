import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay, torontoHour } from './day';

/**
 * WHEN families text: inbound counts by Toronto-local day × hour-of-day, the
 * heatmap's substrate. Sparse (row count bounded by active days × 24); the
 * client slices the dial window, then folds day-keys to weekdays.
 */
export interface TextingHourRow {
  day: string;
  hour: number;
  count: number;
}

export async function loadTextingByHour(
  database: Database = defaultDb(),
): Promise<TextingHourRow[]> {
  const m = schema.channelMessages;
  const day = torontoDay(m.createdAt);
  const hour = torontoHour(m.createdAt);
  return database
    .select({
      day,
      hour,
      count: sql<number>`count(*)::int`,
    })
    .from(m)
    .where(
      sql`${m.direction} = 'in' and ${m.createdAt} >= now() - make_interval(days => ${TREND_DAYS})`,
    )
    .groupBy(day, hour)
    .orderBy(day, hour);
}
