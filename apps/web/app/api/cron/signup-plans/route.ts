import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { registrationPlanRunEnabled } from '~/lib/signup/plan/flag';
import { signupPlanDepsFromEnv } from '~/lib/signup/plan/notice';
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
  const result = await runDueSignupPlans(
    database,
    { now: new Date() },
    signupPlanDepsFromEnv(database),
  );
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});
