import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { requireCronSecret } from '~/lib/cron/auth';
import { runDigestCron } from '~/lib/cron/digest';

// Node runtime: the agent reads its skill file off disk, calls the Anthropic SDK,
// and sends email via Resend — none of which work on the edge runtime.
export const runtime = 'nodejs';
// Each family runs a bounded agent + an email send; allow the full Fluid Compute
// window so a batch of families completes in one invocation.
export const maxDuration = 300;

/**
 * GET /api/cron/digest — the daily morning brief run, triggered by Vercel Cron.
 *
 * Cron auth is the spend gate: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the engine does NOTHING —
 * no DB read, no model call, no email, no spend (rule #7's spirit at the run
 * boundary). Only a legitimate cron call composes briefs. Each family is bounded
 * (per-run cap + the harness's maxSteps × maxTokens token ceiling); every model/
 * tool call is guarded (audit + cap + teen-redaction — rules #1/#6/#7).
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const summary = await runDigestCron(db());
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
