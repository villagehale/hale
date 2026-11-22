#!/usr/bin/env tsx
// Ops path: stop every day-before plan running right now. A plan not yet past its paying
// checkpoint can no longer start a payment, and a later sweep lets each run go. Dry-run unless
// --apply is passed. Prints counts only, never a family, an offer or a host, and texts no
// parent. The order to run it in is in docs/launch-runbook.md, under Rollback.
//
//   pnpm signup:stop-plans
//   pnpm signup:stop-plans -- --apply
//
// Needs DATABASE_URL. --apply also needs PLAN_OPS_STOP_ENABLED exactly `true`.

import { createDb } from '@hale/db';
import { PLAN_OPS_STOP_ENABLED_ENV, planOpsStopEnabled } from '../lib/signup/plan/flag';
import { runPlanStop } from '../lib/signup/plan/store';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const mode = apply ? 'apply' : 'dry_run';
let exitCode = 0;
if (apply && !planOpsStopEnabled()) {
  console.error(JSON.stringify({ mode, refused: PLAN_OPS_STOP_ENABLED_ENV }));
  exitCode = 1;
} else {
  try {
    const database = createDb({ connectionString: url });
    console.info(JSON.stringify(await runPlanStop(database, { apply, now: new Date() })));
  } catch (err) {
    // A bad URL's error carries the whole connection string and a driver error can carry row
    // values (a key, a host), so only the code is printed.
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
    console.error(JSON.stringify({ mode, failed: code }));
    exitCode = 1;
  }
}
process.exit(exitCode);
