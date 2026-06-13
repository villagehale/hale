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

    // These actions' events have no child_id — all flow into the unattributed
    // bucket, and the per-child sections are empty (single-child contract intact).
    expect(row?.perChildBreakdown?.children).toEqual([]);
    expect(row?.perChildBreakdown?.unattributed.totalCount).toBe(5);
    expect(row?.perChildBreakdown?.coordinationFlags).toEqual([]);

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

  it('groups per-child and flags a sibling calendar overlap', async () => {
    const { runDailyDigest } = await import('./daily-digest.js');
    const digestDate = '2026-04-20';

    const familyRows = await database
      .insert(schema.families)
      .values({ displayName: 'Sibling Family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = familyRows[0]?.id as string;

    const [mia] = await database
      .insert(schema.children)
      .values({ familyId, name: 'Mia', dateOfBirth: '2023-09-01' })
      .returning({ id: schema.children.id });
    const [noah] = await database
      .insert(schema.children)
      .values({ familyId, name: 'Noah', dateOfBirth: '2026-02-01' })
      .returning({ id: schema.children.id });
    const miaId = mia?.id as string;
    const noahId = noah?.id as string;

    const draftedAt = new Date(`${digestDate}T12:00:00.000Z`);

    // Helper: one event (with optional child_id) + one action drafted today.
    async function seed(
      childId: string | null,
      userVisibleState: (typeof schema.actions.$inferInsert)['userVisibleState'],
      actionType: string,
      payload: Record<string, unknown>,
    ): Promise<void> {
      const eventRows = await database
        .insert(schema.events)
        .values({
          familyId,
          source: 'calendar_diff',
          eventType: 'calendar_conflict_detected',
          dedupHash: `sib-${Date.now()}-${Math.random()}`,
          status: 'actioned',
          childId,
        })
        .returning({ id: schema.events.id });
      await database.insert(schema.actions).values({
        eventId: eventRows[0]?.id as string,
        familyId,
        actionType,
        payload,
        userVisibleState,
        draftedAt,
      });
    }

    // Two overlapping calendar events for DIFFERENT children (16:30 vs 16:45,
    // 60-min default windows overlap) → one coordination flag.
    await seed(miaId, 'autonomous', 'create_calendar_event', {
      title: 'Mia swim',
      startsAt: '2026-04-20T16:30:00-04:00',
    });
    await seed(noahId, 'drafted_for_approval', 'create_calendar_event', {
      title: 'Noah checkup',
      startsAt: '2026-04-20T16:45:00-04:00',
    });
    // One unattributed action (family-wide).
    await seed(null, 'autonomous', 'send_email', { to: 'x@y.ca' });

    await runDailyDigest({ familyId, digestDate }, database);

    const digests = await database
      .select()
      .from(schema.dailyDigests)
      .where(eq(schema.dailyDigests.familyId, familyId));
    const breakdown = digests[0]?.perChildBreakdown;

    // Family-level totals unchanged in shape: 3 actions, 2 handled, 1 awaiting.
    expect(digests[0]?.totalCount).toBe(3);
    expect(digests[0]?.handledCount).toBe(2);

    // Per-child: Mia has 1 handled, Noah has 1 awaiting; 1 unattributed.
    const mias = breakdown?.children.find((c) => c.childId === miaId);
    const noahs = breakdown?.children.find((c) => c.childId === noahId);
    expect(mias?.name).toBe('Mia');
    expect(mias?.handledCount).toBe(1);
    expect(mias?.totalCount).toBe(1);
    expect(noahs?.name).toBe('Noah');
    expect(noahs?.awaitingCount).toBe(1);
    expect(breakdown?.unattributed.totalCount).toBe(1);

    // The sibling calendar-overlap flag is present (a flag, not a block).
    expect(breakdown?.coordinationFlags).toHaveLength(1);
    expect(breakdown?.coordinationFlags[0]?.kind).toBe('sibling_calendar_overlap');
    expect([
      breakdown?.coordinationFlags[0]?.childId,
      breakdown?.coordinationFlags[0]?.siblingChildId,
    ].sort()).toEqual([miaId, noahId].sort());
  }, 30_000);
});
