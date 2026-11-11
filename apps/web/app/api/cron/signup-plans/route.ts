import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { registrationPlanRunEnabled } from '~/lib/signup/plan/flag';
import { signupPlanDepsFromEnv, signupPlanPrepDepsFromEnv } from '~/lib/signup/plan/notice';
import { runDueSignupPlanPrep } from '~/lib/signup/plan/prep';
import { runDueSignupPlans } from '~/lib/signup/plan/run';

// Node runtime: the sweep opens Postgres and drives Browser Use runs.
export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * GET /api/cron/signup-plans — every minute (vercel.json). Carries out each day-before
 * registration plan whose open is now (VIL-558). Off unless REGISTRATION_PLAN_RUN_ENABLED
 * is exactly `true`: with it off the route builds nothing, claims nothing and says
 * `skipped: 'flag_off'` (cronRoute still stamps its heartbeat). Without BROWSER_USE_API_KEY
 * the sweep names `not_configured` and claims no plan.
 */
export const GET = cronRoute('signup-plans', async () => {
  if (!registrationPlanRunEnabled()) {
    return NextResponse.json({ ok: true, skipped: 'flag_off' }, { status: 200 });
  }
  const database = db();
  const now = new Date();
  const prep = await runDueSignupPlanPrep(database, { now }, signupPlanPrepDepsFromEnv(database));
  const result = await runDueSignupPlans(database, { now }, signupPlanDepsFromEnv(database));
  return NextResponse.json({ ok: true, ...result, prep }, { status: 200 });
});
