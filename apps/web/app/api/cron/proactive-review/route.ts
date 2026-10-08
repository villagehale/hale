import { NextResponse } from 'next/server';
import { runProactiveReview } from '~/lib/channel/proactive/review';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/proactive-review — VIL-226. Hourly, off the other texting
 * minutes. While the flag is off this returns immediately and sends nothing.
 * A family with an empty queue is not reviewed, so the model is not called.
 */
export const GET = cronRoute('proactive-review', async () => {
  const summary = await runProactiveReview(db());
  return NextResponse.json({ ok: true, ...summary });
});
