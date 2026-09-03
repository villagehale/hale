import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { CONSUMED_SEND_STATUSES } from '~/lib/channel/ledger';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

/** One Toronto-local day of SMS traffic. Sparse — fillWindow() zero-fills. */
export interface TextingDay {
  day: string;
  /** Distinct parents who texted IN that day — the line's daily heartbeat. */
  senders: number;
  msgsIn: number;
  /** Sends that reached the provider. A suppression (quiet hours, cap, consent,
   * pref) is a ledger row for a message Hale CHOSE not to send — counting it here
   * would both inflate outbound volume and dilute msgsFailed/msgsOut, the
   * delivery-health rate this table exists to make readable (2026-09-03 audit). */
  msgsOut: number;
  /** Sends that failed — the numerator of the delivery-health rate. */
  msgsFailed: number;
}

/** The statuses that mean "the provider was contacted" — the dedupe vocabulary
 * (ledger.ts), reused so the founder's out count and the send ledger cannot drift. */
const REAL_SEND_STATUSES = sql.join(
  CONSUMED_SEND_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

export async function loadTextingTrends(database: Database = defaultDb()): Promise<TextingDay[]> {
  const day = torontoDay(schema.channelMessages.createdAt);
  return database
    .select({
      day,
      senders: sql<number>`count(distinct ${schema.channelMessages.parentUserId}) filter (where ${schema.channelMessages.direction} = 'in')::int`,
      msgsIn: sql<number>`count(*) filter (where ${schema.channelMessages.direction} = 'in')::int`,
      msgsOut: sql<number>`count(*) filter (where ${schema.channelMessages.direction} = 'out' and ${schema.channelMessages.status} in (${REAL_SEND_STATUSES}))::int`,
      msgsFailed: sql<number>`count(*) filter (where ${schema.channelMessages.direction} = 'out' and ${schema.channelMessages.status} = 'failed')::int`,
    })
    .from(schema.channelMessages)
    .where(sql`${schema.channelMessages.createdAt} >= now() - make_interval(days => ${TREND_DAYS})`)
    .groupBy(day)
    .orderBy(day);
}
