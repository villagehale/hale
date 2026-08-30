import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';

export interface RadarData {
  /** The next windows to open, soonest first. */
  upcoming: {
    municipality: string;
    programDomain: string;
    cycleLabel: string;
    openAt: string;
    residentOpenAt: string | null;
  }[];
  /** Freshest verified_at across ALL windows — the radar's honesty stamp. */
  freshestVerifiedAt: string | null;
  /** The latest weekly verify sweep, if one has ever run. */
  lastVerifyRun: {
    ranAt: string;
    checked: number;
    confirmed: number;
    discrepancies: number;
    unverified: number;
  } | null;
  /** What parents reported across all sequences (null outcome = still open). */
  outcomes: { outcome: string; count: number }[];
}

export async function loadRadar(database: Database = defaultDb()): Promise<RadarData> {
  const w = schema.registrationWindows;

  const upcoming = await database
    .select({
      municipality: sql<string>`${w.municipality}`,
      programDomain: sql<string>`${w.programDomain}`,
      cycleLabel: w.cycleLabel,
      openAt: sql<string>`to_char(${w.openAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      residentOpenAt: sql<string | null>`to_char(${w.residentOpenAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(w)
    .where(sql`${w.openAt} >= now() or ${w.residentOpenAt} >= now()`)
    .orderBy(w.openAt)
    .limit(8);

  const [fresh] = await database
    .select({
      freshestVerifiedAt: sql<string | null>`to_char(max(${w.verifiedAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(w);

  const runs = await database
    .select({
      ranAt: sql<string>`to_char(${schema.registrationVerifyRuns.ranAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
      checked: schema.registrationVerifyRuns.checked,
      confirmed: schema.registrationVerifyRuns.confirmed,
      discrepancies: schema.registrationVerifyRuns.discrepancies,
      unverified: schema.registrationVerifyRuns.unverified,
    })
    .from(schema.registrationVerifyRuns)
    .orderBy(sql`${schema.registrationVerifyRuns.ranAt} desc`)
    .limit(1);

  const outcomes = await database
    .select({
      outcome: sql<string>`coalesce(${schema.registrationSequences.outcome}::text, 'open')`,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.registrationSequences)
    .groupBy(sql`coalesce(${schema.registrationSequences.outcome}::text, 'open')`);

  return {
    upcoming,
    freshestVerifiedAt: fresh?.freshestVerifiedAt ?? null,
    lastVerifyRun: runs[0] ?? null,
    outcomes,
  };
}
