import { NextResponse } from 'next/server';
import { defaultProactiveReviewDeps, runProactiveReview } from '~/lib/channel/proactive/review';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/proactive-review — VIL-226. Hourly, on a minute no other texting leg
 * uses. While PROACTIVE_CADENCE is unset this returns at once and reads nothing. A
 * family whose queue holds nothing the model may see is not reviewed, so the model is
 * not called for it.
 */
export const GET = cronRoute('proactive-review', async () => {
  const summary = await runProactiveReview(db(), defaultProactiveReviewDeps(), new Date());
  return NextResponse.json({ ok: true, ...summary });
});
