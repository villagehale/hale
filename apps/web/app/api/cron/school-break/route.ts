import { NextResponse } from 'next/server';
import { defaultSchoolBreakSweepDeps, runSchoolBreakSweep } from '~/lib/care/school-break/sweep';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reads skills off disk, fetches board pages through the pinned
// fetcher and calls the Anthropic SDK — none of which work on the edge.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/school-break — VIL-685. Hourly: each family's 2026-27 winter break, read
 * off their own board's calendar page (the host their school mail comes from) and cached
 * per board, or one daytime question queued for the proactive decider when no page has
 * it. Its kill switch (SCHOOL_BREAK_ENABLED) defaults on; `false` reads nothing.
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
    const summary = await runSchoolBreakSweep(db(), defaultSchoolBreakSweepDeps(client));
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
