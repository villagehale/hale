import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, schema } from '@hale/db';

/**
 * B8 INTEGRATION — proves real agent_runs rows + FK joins against a live
 * Postgres. BLOCKED locally: no DATABASE_URL exists (CREDENTIALS MATRIX in
 * .loop/STATE.md). Guarded so it neither fails nor silently no-ops the suite;
 * it logs a loud blocker so the orchestrator marks B8-integration honestly.
 *
 * When DATABASE_URL is present, this asserts a full classify→draft→review pass
 * writes ≥3 agent_runs rows (classifier + drafter + reviewer) and that
 * actions.drafted_by_agent_run_id FK-joins to a real agent_runs row.
 */
// vitest.setup.ts injects a dummy DATABASE_URL so module-load env validation
// passes; that placeholder is NOT a live DB. Treat it as absent here.
const TEST_PLACEHOLDER = 'postgres://test:test@localhost:5432/test';
const hasDb = Boolean(process.env.DATABASE_URL) && process.env.DATABASE_URL !== TEST_PLACEHOLDER;

if (!hasDb) {
  console.warn(
    '\n[B8-integration BLOCKED] DATABASE_URL is not set — the live agent_runs FK-join ' +
      'integration test is SKIPPED. This leg is BLOCKED-not-done until Supabase/DATABASE_URL ' +
      'is provided. Run with a real DATABASE_URL to exercise it.\n',
  );
}

describe.skipIf(!hasDb)('B8 integration — real agent_runs rows + FK joins', () => {
  const database = createDb({ connectionString: process.env.DATABASE_URL as string });

  afterAll(async () => {
    // postgres-js exposes the client for teardown; best-effort.
    const maybeClient = (database as unknown as { $client?: { end?: () => Promise<void> } }).$client;
    await maybeClient?.end?.();
  });

  it('a full pipeline pass writes ≥3 agent_runs rows with valid FK joins', async () => {
    const { runOrchestrator } = await import('./index.js');

    const familyRows = await database
      .insert(schema.families)
      .values({ displayName: 'B8 Integration Family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = familyRows[0]?.id as string;

    // A real child row, so the now-wired stage lookup (loadFamilyContext) has
    // children to derive from. ~6 months old → 'newborn', consistent with the
    // clinic 6-month-checkup signal below; this keeps the classifier's pack the
    // same while exercising the stage-aware path against real rows.
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    await database.insert(schema.children).values({
      familyId,
      name: 'Baby Chen',
      dateOfBirth: sixMonthsAgo.toISOString().slice(0, 10),
    });

    // This test's intent is DB/FK plumbing (≥3 agent_runs, draftedByAgentRunId
    // FK resolves), NOT classifier quality. The classifier must route to
    // autonomous_action with a known actionType for the drafter+reviewer to run,
    // so we feed it a realistic clinic confirmation request — the same shape the
    // tuned classifier eval routes to autonomous_action/reply_to_email at 100%
    // (evals/fixtures/classifier/02-pediatric-confirm-request). A real pass is
    // used (not an injected classification): the tuned prompt routes this input
    // reliably, so the live LLM exercise stays a true end-to-end plumbing check.
    await runOrchestrator({
      family_id: familyId,
      source: 'gmail',
      payload: {
        messageId: `integ-${Date.now()}`,
        body:
          'From: frontdesk@littlesprout-pediatrics.ca\n' +
          'Subject: Please confirm your 6-month visit\n\n' +
          "Hi, it's time to schedule Baby Chen's 6-month checkup. Please call us " +
          'or use the portal to pick a slot in the next two weeks. We have ' +
          'openings Mon-Thu mornings. Please reply to confirm.',
      },
      received_at: new Date().toISOString(),
    });

    const runs = await database
      .select({ id: schema.agentRuns.id, agentName: schema.agentRuns.agentName })
      .from(schema.agentRuns)
      .where(sql`${schema.agentRuns.familyId} = ${familyId}`);

    expect(runs.length).toBeGreaterThanOrEqual(3);

    // FK join: every action's drafted_by_agent_run_id resolves to an agent_runs row.
    const joined = await database
      .select({ actionId: schema.actions.id, runId: schema.agentRuns.id })
      .from(schema.actions)
      .innerJoin(
        schema.agentRuns,
        sql`${schema.actions.draftedByAgentRunId} = ${schema.agentRuns.id}`,
      )
      .where(sql`${schema.actions.familyId} = ${familyId}`);

    expect(joined.length).toBeGreaterThanOrEqual(1);

    // Stage-aware path: the now-wired loadFamilyContext derives the child's stage
    // and age from the real children row this test inserted. A 6-month-old →
    // 'newborn', age in months in [5, 7] (calendar-month boundary tolerance).
    const { loadFamilyContext } = await import('../services/memory-writer.js');
    const context = await loadFamilyContext(familyId, database);
    expect(context.stages).toEqual(['newborn']);
    expect(context.contextSlice.province).toBe('ON');
    expect(context.contextSlice.childrenAgesMonths).toHaveLength(1);
    expect(context.contextSlice.childrenAgesMonths[0]).toBeGreaterThanOrEqual(5);
    expect(context.contextSlice.childrenAgesMonths[0]).toBeLessThanOrEqual(7);
    // 60s: a full pass makes three REAL, sequential LLM calls (classifier +
    // drafter + reviewer — hard rule #8 forbids mocking the model), which
    // overruns vitest's 5s default. The work is network-bound, not slow code.
  }, 60_000);
});
