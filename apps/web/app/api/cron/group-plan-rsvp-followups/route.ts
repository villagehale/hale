import { NextResponse } from 'next/server';
import { linqGroupPlanRsvpEnabled } from '~/lib/channel/linq/config';
import { runGroupPlanFollowups } from '~/lib/channel/linq/group-plan-rsvp/followups';
import {
  GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
  sendGroupPlanRsvpLine,
} from '~/lib/channel/linq/group-plan-rsvp/send';
import { createPostgresGroupPlanRsvpStore } from '~/lib/channel/linq/group-plan-rsvp/store';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/group-plan-rsvp-followups — VIL-442 (T15) one follow-up wave
 * for people still waiting on a group plan.
 *
 * Dark while LINQ_GROUP_PLAN_RSVP_ENABLED is not exactly `true`. Quiet hours
 * and the claim live in the sweep. Cron auth is the spend gate.
 */
export const GET = cronRoute('group-plan-rsvp-followups', async () => {
  try {
    if (!linqGroupPlanRsvpEnabled()) {
      return NextResponse.json({ ok: true, dark: true, evaluated: 0, sent: 0 }, { status: 200 });
    }
    const summary = await runGroupPlanFollowups({
      store: createPostgresGroupPlanRsvpStore(db()),
      send: async ({ chatId, text }) =>
        sendGroupPlanRsvpLine(db(), {
          chatId,
          text,
          templateKey: GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
          now: new Date(),
        }),
    });
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
});
