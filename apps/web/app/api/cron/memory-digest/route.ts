import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { runMemoryDigestCron } from '~/lib/cron/memory-digest';
import { db } from '~/lib/db';

// Node runtime: digest windows use Intl time zones and the Drizzle client.
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/memory-digest — daily memory rollup. Observe-only unless
 * MEMORY_DIGEST_APPLY is exactly `true` and the family is on
 * MEMORY_DIGEST_FAMILY_ALLOWLIST. Counts only; no message bodies, no sends.
 */
export const GET = cronRoute('memory-digest', async () => {
  const summary = await runMemoryDigestCron(db());
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
});
