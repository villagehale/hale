import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

/** One Toronto-local day of SMS traffic. Sparse — fillWindow() zero-fills. */
export interface TextingDay {
  day: string;
  /** Distinct parents who texted IN that day — the line's daily heartbeat. */
  senders: number;
  msgsIn: number;
  msgsOut: number;
  /** Sends that failed — the numerator of the delivery-health rate. */
  msgsFailed: number;
}

export async function loadTextingTrends(database: Database = defaultDb()): Promise<TextingDay[]> {
  const day = torontoDay(schema.channelMessages.createdAt);
  return database
    .select({
      day,
      senders: sql<number>`count(distinct ${schema.channelMessages.parentUserId}) filter (where ${schema.channelMessages.direction} = 'in')::int`,
      msgsIn: sql<number>`count(*) filter (where ${schema.channelMessages.direction} = 'in')::int`,
      msgsOut: sql<number>`count(*) filter (where ${schema.channelMessages.direction} = 'out')::int`,
      msgsFailed: sql<number>`count(*) filter (where ${schema.channelMessages.status} = 'failed')::int`,
    })
    .from(schema.channelMessages)
    .where(sql`${schema.channelMessages.createdAt} >= now() - make_interval(days => ${TREND_DAYS})`)
    .groupBy(day)
    .orderBy(day);
}
