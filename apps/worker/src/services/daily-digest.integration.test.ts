import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema } from '@hearth/db';

/**
 * FIX 2 INTEGRATION — runDailyDigest must WRITE a daily_digests summary row, not
 * just log. Asserts a real row against a live Postgres with the correct per-state
 * tallies. Guarded exactly like the agent_runs integration test: BLOCKED (skipped,
 * loud) without a live DATABASE_URL, run when one is present.
 *
 * The day's actions are seeded across every user_visible_state so each tally is
 * derived from a DISTINCT count (not all the same number): 2 autonomous → handled,
 * 1 drafted_for_approval → awaiting, 1 needs_human → needsYou, 1 reverted.
 */
const TEST_PLACEHOLDER = 'postgres://test:test@localhost:5432/test';
const hasDb = Boolean(process.env.DATABASE_URL) && process.env.DATABASE_URL !== TEST_PLACEHOLDER;

if (!hasDb) {
  console.warn(
    '\n[daily-digest integration BLOCKED] DATABASE_URL is not set — the live ' +
      'daily_digests write integration test is SKIPPED. Run with a real DATABASE_URL ' +
      'to exercise it.\n',
  );
}

describe.skipIf(!hasDb)('FIX 2 integration — runDailyDigest writes a daily_digests row', () => {
  const database = createDb({ connectionString: process.env.DATABASE_URL as string });

  afterAll(async () => {
    const maybeClient = (database as unknown as { $client?: { end?: () => Promise<void> } }).$client;
    await maybeClient?.end?.();
  });

  it('writes one row with per-state tallies derived from the day\'s actions', async () => {
    const { runDailyDigest } = await import('./daily-digest.js');

    const digestDate = '2026-03-15';

    const familyRows = await database
      .insert(schema.families)
      .values({ displayName: 'Digest Family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = familyRows[0]?.id as string;

    const draftedAt = new Date(`${digestDate}T12:00:00.000Z`);
    const states: Array<(typeof schema.actions.$inferInsert)['userVisibleState']> = [
      'autonomous',
      'autonomous',
      'drafted_for_approval',
      'needs_human',
      'reverted',
    ];
    // One event per action — actions.event_id is uniquely indexed (one action
    // per event, the FIX 2 idempotency claim), so each action needs its own event.
    for (const [i, userVisibleState] of states.entries()) {
      const eventRows = await database
        .insert(schema.events)
        .values({
          familyId,
          source: 'gmail',
          eventType: 'pediatric_office_message',
          dedupHash: `digest-${Date.now()}-${i}`,
          status: 'actioned',
        })
        .returning({ id: schema.events.id });
      const eventId = eventRows[0]?.id as string;
      await database.insert(schema.actions).values({
        eventId,
        familyId,
        actionType: 'send_email',
        payload: {},
        userVisibleState,
        draftedAt,
      });
    }

    await runDailyDigest({ familyId, digestDate }, database);

    const digests = await database
      .select()
      .from(schema.dailyDigests)
      .where(eq(schema.dailyDigests.familyId, familyId));

    expect(digests).toHaveLength(1);
    const row = digests[0];
    expect(row?.digestDate).toBe(digestDate);
    expect(row?.handledCount).toBe(2);
    expect(row?.awaitingCount).toBe(1);
    expect(row?.needsYouCount).toBe(1);
    expect(row?.revertedCount).toBe(1);
    expect(row?.totalCount).toBe(5);

    // Idempotent re-run upserts the same (family_id, digest_date) row, never a
    // duplicate, and the tallies are unchanged.
    await runDailyDigest({ familyId, digestDate }, database);
    const afterRerun = await database
      .select()
      .from(schema.dailyDigests)
      .where(eq(schema.dailyDigests.familyId, familyId));
    expect(afterRerun).toHaveLength(1);
    expect(afterRerun[0]?.handledCount).toBe(2);
  }, 30_000);
});
