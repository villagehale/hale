import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import {
  defaultRegistrationVerifyDeps,
  runRegistrationVerifySweep,
} from '~/lib/registration/verify-sweep';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the sweep reads the verify-registration-window skill off disk and
// calls the Anthropic SDK — neither works on the edge.
export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/registration-verify — the weekly registration-window freshness
 * loop (VIL-259), the sweep M1 specified and did not ship. Triggered by Vercel Cron.
 *
 * Cron auth is the spend gate: without the matching `Authorization: Bearer
 * <CRON_SECRET>` the request gets 401 and nothing runs — no fetch, no model call,
 * no writes.
 *
 * Weekly because that is how often these calendars move: a municipality announces
 * a season once and then leaves the page alone for months. Sweeping harder would
 * spend more to learn the same thing, and every source here is a public body whose
 * page we are a guest on.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  try {
    const summary = await runRegistrationVerifySweep(db(), defaultRegistrationVerifyDeps(client));
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of 500-ing silently: log, then re-throw so the
    // run stays a real error rather than a masked success (rule #8).
    console.error({ err }, 'cron/registration-verify failed');
    throw err;
  } finally {
    await flushTelemetry();
  }
}
