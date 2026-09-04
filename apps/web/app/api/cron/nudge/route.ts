import { NextResponse } from 'next/server';
import { runFollowupSweep } from '~/lib/channel/followup/run';
import { runNudgeCron } from '~/lib/channel/nudge/run';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';
import { runActivityFollowUpSweep } from '~/lib/channel/activity/sweep';
import { runPlanCheckInSweep } from '~/lib/channel/plan/check-in';
import { runVillageIntroSweep } from '~/lib/village/intros/run';

// Node runtime: the sweep reaches the voice client and the channel seam, neither of
// which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/nudge — the F14 proactive nudge sweep (VIL-239 · M4), triggered HOURLY
 * by Vercel Cron. Its own route rather than a leg of /api/cron/reminders: the reminders
 * cron converges a ledger of things a parent already asked for, while this one decides
 * whether to interrupt a parent at all. Sharing a route would mean one failure budget,
 * one timeout, and one set of logs for two very different risks.
 *
 * It only ever acts on a family in their local send hour, so most hours are a no-op.
 *
 * Two gates, both fail-closed. Cron auth is the spend gate: a request without
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and NOTHING runs. F14_ENABLED /
 * F14_FAMILY_ALLOWLIST is the D21 dark-launch gate: unarmed, the sweep does not even
 * select families.
 *
 * THE VILLAGE INTRO SWEEP RIDES THIS ROUTE as a second step rather than taking a cron
 * slot of its own. It asks the same question about a different subject — may Hale
 * interrupt this parent, and with what — and it needs the same hourly cadence. It has
 * its OWN dark-launch flag (VILLAGE_INTROS_ENABLED), so arming F14 does not arm
 * cross-household introductions. It runs SECOND and independently: the nudge sweep has
 * already committed its own work before this starts, so an intro failure cannot undo a
 * nudge, and each family-level error inside either sweep is caught by that sweep.
 *
 * THE ACTIVITY FOLLOW-UP SWEEP rides here too, and runs after all of them for one
 * reason the others do not have: it is the only stage that DISCHARGES A DEBT rather than
 * choosing to interrupt. Running it last means a household that has just been handed a
 * nudge, an intro card or a check-in is over its budget by the time this asks — and being
 * held costs nothing here, because the promise stays open and comes back on the next tick
 * rather than being dropped. It shares F14's dark-launch flag: this message only exists
 * for a family already texting Hale.
 *
 * THE FOLLOW-UP SWEEP rides here for the same reason and runs LAST, which is also its
 * priority. It is the only stage that asks about something already over, so it is the
 * one whose deferral costs a family nothing — and running after the others means a
 * household that has just been handed a nudge or an intro card is not also asked how
 * last week went. It carries its own dark-launch flag (FOLLOWUP_ASKS_ENABLED).
 */
export const GET = cronRoute('nudge', async () => {
  try {
    const summary = await runNudgeCron(db());
    const villageIntros = await runVillageIntroSweep(db());
    const followups = await runFollowupSweep(db());
    const planCheckIns = await runPlanCheckInSweep(db());
    const activityFollowUps = await runActivityFollowUpSweep(db());
    return NextResponse.json(
      { ok: true, ...summary, villageIntros, followups, planCheckIns, activityFollowUps },
      { status: 200 },
    );
  } finally {
    await flushTelemetry();
  }
});
