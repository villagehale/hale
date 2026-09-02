import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runPapercutDigestCron } from '~/lib/loop/papercut-digest';

// Node runtime: Resend + the postgres driver aren't edge-compatible.
export const runtime = 'nodejs';

/**
 * GET /api/cron/papercut-digest — the weekly papercut recorder: every persisted
 * degradation of the trailing 7 days (unmet intents, medical fixed-line fallbacks,
 * general-answer fallbacks, loop-voice failures, broken turns) bucketed by closed vocab
 * with counts and row ids, emailed to the founder as the eval-fixture shopping list.
 * A clean week is a named skip (`digest_skipped_empty`), never an empty email; a sender
 * with nowhere to send degrades to a named no-op via its own guards (loop-health
 * digest's exact pattern — internal ops mail, no send flag).
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const result = await runPapercutDigestCron(db());
  return NextResponse.json({ ok: true, outcome: result.outcome }, { status: 200 });
}
