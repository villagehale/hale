import { type Database, schema } from '@hale/db';

/**
 * The dead-man switch's write side (audit P1-8): one upsert per completed cron
 * run. Called by the shared `cronRoute` wrapper — never by handlers directly —
 * so a new cron cannot forget to stamp (heartbeat-guard.test.ts enforces that
 * every cron route goes through the wrapper).
 */
export async function stampCronHeartbeat(database: Database, name: string): Promise<void> {
  const now = new Date();
  await database
    .insert(schema.cronHeartbeats)
    .values({ name, lastRanAt: now })
    .onConflictDoUpdate({ target: schema.cronHeartbeats.name, set: { lastRanAt: now } });
}

/**
 * Arms crons the ledger has never seen: inserts a baseline row at now() and
 * touches nothing that exists. The health endpoint calls this for `armed`
 * entries so a newly scheduled cron's clock starts at first sight instead of
 * paging falsely until its first slot (a weekly cron would otherwise read
 * stale for up to a week). ON CONFLICT DO NOTHING keeps a concurrent real
 * stamp authoritative.
 */
export async function armCronHeartbeats(database: Database, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await database
    .insert(schema.cronHeartbeats)
    .values(names.map((name) => ({ name })))
    .onConflictDoNothing();
}
