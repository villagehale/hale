#!/usr/bin/env tsx
// Ops path: stop every day-before plan running right now. None of them starts a payment after
// it, and a later sweep lets each run go. Dry-run unless --apply is passed. Prints counts only,
// never a family, an offer or a host, and texts no parent. The order to run it in is in
// docs/launch-runbook.md, under Rollback.
//
//   pnpm signup:stop-plans
//   pnpm signup:stop-plans -- --apply
//
// Needs DATABASE_URL.

import { createDb } from '@hale/db';
import { runPlanStop } from '../lib/signup/plan/store';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const mode = apply ? 'apply' : 'dry_run';
const database = createDb({ connectionString: url });
let exitCode = 0;
try {
  console.info(JSON.stringify(await runPlanStop(database, { apply, now: new Date() })));
} catch (err) {
  // A driver error can carry row values (a key, a host), so only its code is printed.
  const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
  console.error(JSON.stringify({ mode, failed: code }));
  exitCode = 1;
}
process.exit(exitCode);
