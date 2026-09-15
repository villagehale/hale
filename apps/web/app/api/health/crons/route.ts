import { schema } from '@hale/db';
import { and, inArray, sql } from 'drizzle-orm';
import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { NextResponse } from 'next/server';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { assessCronHealth, assessInboundLane } from '~/lib/cron/deadman';
import { armCronHeartbeats } from '~/lib/cron/heartbeat';
import { db } from '~/lib/db';
import vercelConfig from '~/vercel.json';

/**
 * The three columns of pg-boss's own `pgboss.job` this endpoint reads — a VIEW
 * onto a table pg-boss owns and migrates, never a schema Hale declares.
 *
 * A drizzle table rather than `db().execute(sql…)` on purpose: drizzle's pglite
 * session hands back `{rows}` while postgres-js hands back a RowList array, so
 * an `execute()` reader passes every test here and returns undefined in
 * production — the exact cross-driver shape that took the inbound lane down
 * (#622). The query builder reads identically on both drivers.
 */
const pgbossJob = pgSchema('pgboss').table('job', {
  name: text('name').notNull(),
  state: text('state').notNull(),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull(),
});

/**
 * Seconds since the OLDEST inbound turn that has not reached a terminal state,
 * or null when there is none.
 *
 * The queues are {@link INBOUND_TURN_QUEUES} — the same set the doors kick a drain
 * of — rather than a name of this lane's own, so a second inbound-turn queue is
 * watched the moment it joins the set. A lane naming one queue would go on reading
 * 'ok' through a stall on the other, which is the failure this whole endpoint exists
 * to make impossible.
 *
 * `state` is compared against SQL LITERALS (pg-boss's own idiom): the column is
 * the `pgboss.job_state` enum, and a text-typed bind parameter would have to be
 * cast. `now()` is SQL for the same class of reason — a bound Date is what
 * #622 was. The three live states are pg-boss's own: `created` (queued),
 * `retry` (a handler threw and it is waiting on backoff — where a whole night's
 * texts sat), `active` (in flight).
 */
async function inboundLaneAgeSeconds(): Promise<number | null> {
  const [row] = await db()
    .select({
      ageSeconds: sql<
        number | null
      >`extract(epoch from now() - min(${pgbossJob.createdOn}))::int`,
    })
    .from(pgbossJob)
    .where(
      and(
        inArray(pgbossJob.name, [...INBOUND_TURN_QUEUES]),
        sql`${pgbossJob.state} in ('created', 'retry', 'active')`,
      ),
    );
  return row?.ageSeconds ?? null;
}

// Node runtime: reads cron_heartbeats via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/health/crons — the dead-man switch's public face (audit P1-8).
 *
 * Compares every cron declared in vercel.json (imported, not copied — the file
 * the platform reads is the manifest of record) against its cron_heartbeats
 * stamp and answers ok/stale per cron. The off-Vercel checker
 * (.github/workflows/cron-deadman.yml) polls this from GitHub Actions — a
 * failure domain that shares nothing with the Vercel cron substrate the
 * watchdog layer itself runs on.
 *
 * It also publishes ONE non-cron entry in the same array: `lane:inbound-turns`,
 * the age of the oldest inbound text pg-boss has not finished. A cron stamps on
 * completion, so a drain whose every inbound job threw stamped like a clean run
 * and this endpoint said "ok" for six hours (#617/#622). The lane is the fact
 * that was false the whole time. It rides `crons[]` rather than a field of its
 * own so the off-Vercel checker needs no edit — it filters on the 'stale' token.
 *
 * Unauthenticated BUT unrevealing (rule #1): the body carries cron slugs,
 * ages, and thresholds — liveness metadata only. No error text, no counts, no
 * queue depths, no family data, and nothing here accepts input. The lane obeys
 * the same rule: a name, an enum, and an age published only while stale (an
 * outage duration; a HEALTHY age would say when a family last texted).
 *
 * A cron the ledger has never seen is ARMED — a baseline row is inserted at
 * now() (idempotent, ON CONFLICT DO NOTHING, bounded by the manifest) so its
 * clock starts at first sight instead of paging falsely until its first slot;
 * if it truly never runs it reads stale one threshold later.
 *
 * A DB that cannot be read answers 503 rather than a hollow "ok": to the
 * checker, an unreachable verdict pages exactly like a stale cron — a refusal
 * is not evidence of health.
 */
export async function GET() {
  let rows: (typeof schema.cronHeartbeats.$inferSelect)[];
  try {
    rows = await db().select().from(schema.cronHeartbeats);
  } catch (err) {
    console.error('health/crons: heartbeat ledger unreadable', { err });
    return NextResponse.json(
      { ok: false, error: 'db_unreachable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  let laneAgeSeconds: number | null;
  try {
    laneAgeSeconds = await inboundLaneAgeSeconds();
  } catch (err) {
    // Its OWN refusal, never folded into db_unreachable: the heartbeat ledger
    // was just read fine, so what this names is a missing/renamed pgboss schema
    // or a driver that cannot run the read — not a dead database (rule #11).
    console.error('health/crons: inbound lane unreadable', { err });
    return NextResponse.json(
      { ok: false, error: 'inbound_lane_unreadable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  const report = assessCronHealth(vercelConfig.crons, rows, new Date());
  const lane = assessInboundLane(laneAgeSeconds);

  const armed = report.crons.filter((cron) => cron.status === 'armed').map((cron) => cron.name);
  if (armed.length > 0) {
    try {
      await armCronHeartbeats(db(), armed);
    } catch (err) {
      // Named, logged, and self-healing: the next probe arms again (rule #11).
      console.error('health/crons: arming failed', { armed, err });
    }
  }

  return NextResponse.json(
    {
      ok: report.ok && lane.status !== 'stale',
      generatedAt: new Date().toISOString(),
      crons: [...report.crons, lane],
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
