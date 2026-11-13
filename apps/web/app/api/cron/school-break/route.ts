import { NextResponse } from 'next/server';
import { defaultSchoolBreakSweepDeps, runSchoolBreakSweep } from '~/lib/care/school-break/sweep';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reads skills off disk, fetches school pages through the pinned
// fetcher and calls the Anthropic SDK — none of which work on the edge.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/school-break — VIL-685. Hourly: each school-age family's winter break,
 * read off the calendar page of the school that wrote their own authenticated kid mail
 * (cached per host), or else one daytime question queued for the proactive decider,
 * carrying the days the school's email states for the parent to confirm when it has them. Its kill switch (SCHOOL_BREAK_ENABLED) defaults
 * on; `false` reads nothing.
 *
 * Cron auth is the spend gate: without `Authorization: Bearer <CRON_SECRET>` nothing runs.
 * No model client (no API key) is a named count in the summary, never a silent pass.
 */
export const GET = cronRoute('school-break', async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = apiKey
    ? budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS, { stage: 'discovery' })
    : null;
  try {
    const database = db();
    const summary = await runSchoolBreakSweep(
      database,
      defaultSchoolBreakSweepDeps(database, client),
    );
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    console.error(
      { fault: err instanceof Error ? err.name : typeof err },
      'cron/school-break failed',
    );
    throw err;
  } finally {
    await flushTelemetry();
  }
});
