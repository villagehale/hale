import { NextResponse } from 'next/server';
import { runActivityFollowUpSweep } from '~/lib/channel/activity/sweep';
import { runEveningCheckInSweep } from '~/lib/channel/checkin/sweep';
import { runDepartureNoticeRedrive } from '~/lib/channel/coparent/departure-redrive';
import { sweepDutyAsks } from '~/lib/channel/coparent/duty/asks';
import { activityFollowupAskOpen } from '~/lib/channel/followup/ask-open';
import { runFollowupSweep } from '~/lib/channel/followup/run';
import { departureNoticePorts, welcomeCardRedrivePorts } from '~/lib/channel/inbound-deps';
import { runWelcomeCardRedrive } from '~/lib/channel/intake/welcome-card-redrive';
import { runMidActivityAnswerPass } from '~/lib/channel/mid-activity/answer';
import { runMidActivityAskSweep } from '~/lib/channel/mid-activity/sweep';
import { runNudgeCron } from '~/lib/channel/nudge/run';
import { runPlanCheckInSweep } from '~/lib/channel/plan/check-in';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runWorkstreamFollowupSweep } from '~/lib/memory/workstream-followup';
import { reviewVerdictClient, runReviewCapture } from '~/lib/reviews/capture';
import { createVerdictReader } from '~/lib/reviews/verdict';
import { flushTelemetry } from '~/lib/telemetry/langfuse';
import { runTravelBriefSweep } from '~/lib/travel/sweep';
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
 * THE EVENING CHECK-IN rides here too (VIL-353) and runs before the activity follow-up,
 * because it CHOOSES to interrupt rather than discharging a debt — the same ordering rule
 * the paragraph above states. It is also the one leg whose slot is a legal constraint
 * rather than a preference (20:00 local, see EVENING_CHECK_IN_HOUR_LOCAL), so in any
 * given hour it selects a single band of timezones and does nothing for everyone else.
 *
 * THE TRAVEL BRIEF rides here too, after the evening check-in and BEFORE the activity
 * follow-up, which is the same ordering rule: a travel brief CHOOSES to interrupt, so it
 * runs ahead of the one stage that discharges a debt. No new Vercel cron minute — this
 * needs exactly the cadence the route already has, and vercel-crons.test.ts polices the
 * schedule as a load profile. It has its OWN dark-launch flag (TRAVEL_BRIEF_ENABLED and
 * its allowlist) on top of F14's, because arming the messaging surface for a household
 * must not silently start reading that household's booking emails.
 *
 * THE 08:00 RE-DRIVES ride here last of all — the contact card a family's intake owed
 * them, and the departure notice a co-parent's erasure owed the parent who stayed. They
 * are one leg in two halves and not two mechanisms: the same local hour, the same
 * staleness bound and the same per-run cap, all read from lib/channel/redrive-slot.ts.
 * Neither carries a dark-launch flag of its own, because neither is a class of message —
 * each is a send another module already owed and quiet hours deferred, reaching the same
 * function, spending the same key and writing the same audit verb.
 *
 * THE REVIEW CAPTURE runs after every one of them, and it is the only stage that neither
 * interrupts a parent nor discharges a debt: it sends nothing at all, it only reads what
 * came back to an ask another leg already made. So its failure must not cost a send, and
 * last is where that is true. It carries its own dark-launch flag
 * (ACTIVITY_REVIEWS_ENABLED) on top of F14's and the ask's, because arming the messaging
 * surface for a household must not silently start contributing that household's opinions
 * to other families' recommendations.
 *
 * THE FOLLOW-UP SWEEP rides here for the same reason and runs LAST, which is also its
 * priority. It is the only stage that asks about something already over, so it is the
 * one whose deferral costs a family nothing — and running after the others means a
 * household that has just been handed a nudge or an intro card is not also asked how
 * last week went. It carries its own dark-launch flag (FOLLOWUP_ASKS_ENABLED).
 *
 * THE MID-ACTIVITY ASK (VIL-393) rides after review capture. It is a different
 * question from the follow-up: once, during a series, gated on how often the
 * activity runs and how often the parent wants to be asked. Its flag
 * (MID_ACTIVITY_ASK_ENABLED) is strict `true` and default off. While the line is
 * a design placeholder it holds the send. An answer that does come back is stored
 * on the same activity_reviews row VIL-366 already uses to reorder this household's
 * next find. It does not send an acknowledgment, and it does not read a price.
 *
 * THE WORKSTREAM CHECK-BACK (VIL-419) rides last. It is a follow-up on a thread
 * Hale is still in the middle of, once that thread's check-back time has passed.
 * Its own flag (WORKSTREAMS_ENABLED) is strict `true` and default off. While the
 * flag is off the sweep returns before it reads anything.
 */
export const GET = cronRoute('nudge', async () => {
  try {
    const summary = await runNudgeCron(db());
    // Sunday overview is folded inside the nudge. This pass is the night-before
    // confirmation, the 48-hour re-ask that can ride it, and cancelled-duty
    // invalidation. Its own flag: arming the nudge does not arm duty sends.
    const dutyAsks = await sweepDutyAsks(db());
    const villageIntros = await runVillageIntroSweep(db());
    const followups = await runFollowupSweep(db());
    const planCheckIns = await runPlanCheckInSweep(db());
    const eveningCheckIns = await runEveningCheckInSweep(db());
    const travelBriefs = await runTravelBriefSweep(db());
    const activityFollowUps = await runActivityFollowUpSweep(db());
    const welcomeCards = await runWelcomeCardRedrive(db(), { ports: welcomeCardRedrivePorts() });
    const departureNotices = await runDepartureNoticeRedrive(db(), {
      ports: departureNoticePorts(db()),
    });
    const reviewCapture = await runReviewCapture(db(), {
      askOpen: activityFollowupAskOpen,
      verdict: createVerdictReader(reviewVerdictClient),
      now: new Date(),
    });
    // VIL-393. Its own flag, default off. The ask is held while the line is a
    // design placeholder, and a stored answer reuses the VIL-366 household bias.
    // Neither leg sends, and neither reads a price or a spend cap.
    const answeredAt = new Date();
    const midActivityAsks = await runMidActivityAskSweep(db(), answeredAt);
    const midActivityAnswers = await runMidActivityAnswerPass(db(), {
      verdict: createVerdictReader(reviewVerdictClient),
      now: answeredAt,
    });
    const workstreamFollowups = await runWorkstreamFollowupSweep(db());
    return NextResponse.json(
      {
        ok: true,
        ...summary,
        dutyAsks,
        villageIntros,
        followups,
        planCheckIns,
        eveningCheckIns,
        travelBriefs,
        activityFollowUps,
        welcomeCards,
        departureNotices,
        reviewCapture,
        midActivityAsks,
        midActivityAnswers,
        workstreamFollowups,
      },
      { status: 200 },
    );
  } finally {
    await flushTelemetry();
  }
});
