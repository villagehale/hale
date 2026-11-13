import { NextResponse } from 'next/server';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import {
  defaultCityRegistrationSweepDeps,
  runCityRegistrationSweep,
} from '~/lib/registration/city/sweep';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reads skills off disk, fetches city pages through the pinned
// fetcher and calls the Anthropic SDK — none of which work on the edge.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/city-registration — VIL-684. Hourly: each family's own city's winter
 * registration opening, looked up live on the city's official page and cached per city,
 * and one daytime tell per parent queued for the proactive decider. Its own switch
 * (OWN_CITY_REGISTRATION_ENABLED) is a kill switch, on unless `false`; off reads nothing.
 *
 * Cron auth is the spend gate: without `Authorization: Bearer <CRON_SECRET>` nothing runs.
 * No model client (no API key) is a named count in the summary, never a silent pass.
 */
export const GET = cronRoute('city-registration', async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = apiKey
    ? budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS, { stage: 'registration' })
    : null;
  try {
    const database = db();
    const summary = await runCityRegistrationSweep(
      database,
      defaultCityRegistrationSweepDeps(client, database),
    );
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    console.error(
      { fault: err instanceof Error ? err.name : typeof err },
      'cron/city-registration failed',
    );
    throw err;
  } finally {
    await flushTelemetry();
  }
});
