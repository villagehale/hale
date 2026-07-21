#!/usr/bin/env tsx
// Live probe for the VIL-217 weekly-plan composer (acceptance criterion #4). Composes
// ONE real family's upcoming-week plan through the REAL runWeekPlanForFamily path —
// deterministic gather + compose, the eval-gated one-sentence LLM summary (only when
// ANTHROPIC_API_KEY is set; it degrades cleanly otherwise), the idempotent upsert, and
// the audit row — then reads the persisted week_plans row back and prints its summary +
// the audit row id. Prove the per-family-local path against a NON-Toronto family, not
// just Toronto (the composer's timezone handling is invisible from Toronto).
//
// Secrets come ONLY from the environment — never inlined, never read from
// .loop/launch.env by this script:
//   DATABASE_URL=... ANTHROPIC_API_KEY=... pnpm --filter @hale/web probe:week-plan <family-id>
//
// Idempotent by design: a second run for the same week is a no-op (skipped_existing).
// To force a recompose, delete the week's week_plans row first. Exits nonzero on any
// failure (no row persisted, no audit row, or the compose threw) so it gates cleanly.

import { createDb, schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { defaultWeekPlanDeps, runWeekPlanForFamily } from '../lib/loop/cron';
import { readWeekPlan } from '../lib/loop/queries';

const familyId = process.argv[2];
if (!familyId) {
  console.error('usage: probe:week-plan <family-id>');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const db = createDb({ connectionString: url });

try {
  const result = await runWeekPlanForFamily(familyId, db, defaultWeekPlanDeps());
  console.log(`compose result: ${JSON.stringify(result)}`);
  if (result.status === 'skipped_existing') {
    console.log(
      `week ${result.weekStart} was already composed — delete that week_plans row to force a recompose.`,
    );
  }

  const plan = await readWeekPlan(db, familyId, result.weekStart);
  if (!plan) {
    console.error('FAIL: no week_plans row persisted for this family + week.');
    process.exit(1);
  }
  console.log(
    `week_plans: id=${plan.id} week_start=${plan.weekStart} status=${plan.status} items=${plan.items.length}`,
  );
  console.log(`summary: ${plan.summary ? JSON.stringify(plan.summary) : '(none — LLM stage degraded/off)'}`);
  console.log(`item kinds: ${plan.items.map((i) => i.kind).join(', ') || '(quiet week — no items)'}`);
  console.log(`privacy_sensitive items: ${plan.items.filter((i) => i.privacySensitive).length}`);

  // The immutable audit row this compose wrote (rule #6), for THIS plan row.
  const [audit] = await db
    .select({
      id: schema.auditLog.id,
      actionTaken: schema.auditLog.actionTaken,
      targetId: schema.auditLog.targetId,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'compose_week_plan'),
        eq(schema.auditLog.targetId, plan.id),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(1);
  if (!audit) {
    console.error('FAIL: no compose_week_plan audit_log row for this plan (rule #6).');
    process.exit(1);
  }
  console.log(`audit_log: id=${audit.id} action=${audit.actionTaken} target=${audit.targetId}`);

  console.log('PROBE OK');
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
