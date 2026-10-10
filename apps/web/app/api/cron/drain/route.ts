import { NextResponse, after } from 'next/server';
import type { FirstReplyRecoveryResult } from '~/lib/channel/intake/first-reply-recovery';
import { cronRoute } from '~/lib/cron/auth';
import { DRAINABLE_QUEUES, isConnectionExhaustion, runDrainCron } from '~/lib/cron/drain';
import { socialWatchlistEnabled } from '~/lib/social/flag';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

// Node runtime: the drain instantiates pg-boss (prepared statements, raw pg) and
// runs the worker orchestrator (Anthropic SDK + disk-read prompts) — neither
// works on the edge runtime. maxDuration 800 gives the in-loop ~700s wall-clock
// budget headroom (recipe #1).
export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * GET /api/cron/drain — drains the hot worker queues (events.ingested,
 * actions.approved, and the rest of the drain plan) through the orchestrator
 * pipeline, on every-minute Vercel Cron (yul1). This serverless drain is what
 * consumes those jobs; the after()-kick on the enqueue paths handles the
 * common case immediately and this cron is the safety-net reaper.
 *
 * Cron auth is the gate: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and the drain does NOTHING —
 * no pg-boss connection, no orchestrator run, no spend. Only a legitimate cron
 * call (or the internal after() kick, which carries the same secret) drains.
 *
 * `?queues=a,b` restricts the run to a slice of the drain plan. The inbound kick uses it
 * so a parent's text is picked up on its own rather than behind the outbound and LLM
 * queues that share the tick; the cron passes nothing and drains everything. Concurrent
 * runs are safe — pg-boss hands each job to exactly one fetcher.
 *
 * An unrecognised queue name is a 400 rather than a run that drains nothing and reports
 * success: a typo in a caller's slice would otherwise look exactly like an empty queue.
 */
export const GET = cronRoute('drain', async (req: Request) => {
  const requested = new URL(req.url).searchParams.get('queues');
  const queues = requested ? requested.split(',') : undefined;
  const unknown = queues?.filter((queue) => !DRAINABLE_QUEUES.includes(queue));
  if (unknown?.length) {
    return NextResponse.json({ error: 'unknown_queues', unknown }, { status: 400 });
  }

  // A KICKED run (the doors ask for the inbound slice) answers before it works. The kick
  // that started it aborts at KICK_TIMEOUT_MS and the platform cancels the invocation
  // with the request, so a run that kept the kicker waiting could only ever finish what
  // fits in that window — anything longer died mid-turn and sat `active` until the
  // queue's expiry (observed 2026-09-17). `after` keeps this instance alive for the work
  // once the 202 is out, up to maxDuration, and the kicker is free the moment it hears
  // back. The cost is the 503 contract below: a kicked run can no longer tell the kicker
  // its database is out of connections, so that failure is logged here and the scheduled
  // run picks the turn up. The scheduled run stays synchronous — nothing aborts it, and
  // its summary is the heartbeat's evidence.
  if (queues) {
    after(async () => {
      try {
        const summary = await runDrainCron({ queues });
        console.info({ ...summary, queues }, 'cron/drain kicked run complete');
      } catch (err) {
        console.error(
          { err, queues, dbUnavailable: isConnectionExhaustion(err) },
          'cron/drain kicked run failed',
        );
      } finally {
        await flushTelemetry();
      }
    });
    return NextResponse.json({ ok: true, kicked: true, queues }, { status: 202 });
  }

  // A new parent whose first text got no reply is owed one within minutes, not at the
  // next hourly slot, so the scheduled drain runs the first-reply sweep every minute.
  // BEFORE the queues: it is one indexed read on almost every tick, it must not wait out
  // a backlogged drain, and its own budget (FIRST_REPLY_RECOVERY_BUDGET_MS) fits inside
  // the headroom the drain's wall budget leaves. A kicked run does not take it. A failed
  // leg is named and the drain still runs.
  const firstReply = await runFirstReplyLeg();
  try {
    const summary = await runDrainCron({ queues });
    // Signup-open watches need a tick inside two minutes of registration_opens_at.
    // The hourly social-watch cron is too coarse for that, so the scheduled drain
    // (already every minute) runs the tick when the flag is on. A kicked drain is
    // a parent's inbound slice and does not take this detour. Flag off is named.
    let socialSignup:
      | { skipped: 'flag_off' | 'tick_failed' }
      | { checked: number; updated: number } = { skipped: 'flag_off' };
    if (socialWatchlistEnabled()) {
      try {
        const { runDueSignupWatches } = await import('~/lib/social/poll');
        const { db } = await import('~/lib/db');
        socialSignup = await runDueSignupWatches(db());
      } catch (err) {
        console.error({ err, skipped: 'tick_failed' }, 'cron/drain social signup tick failed');
        socialSignup = { skipped: 'tick_failed' };
      }
    }
    return NextResponse.json({ ok: true, ...summary, socialSignup, firstReply }, { status: 200 });
  } catch (err) {
    // Surface the failure instead of letting it 500 silently: log to the
    // platform, then re-throw so the run is still a real error, not a masked
    // success (rule #8).
    console.error({ err }, 'cron/drain failed');
    // The one exception, and it is a CONTRACT with the kicker rather than a softened
    // error: a drain that could not get a database connection answers 503, because the
    // kicker retries a 500 and a retry here is a second invocation asking for a
    // connection that is not there (lib/cron/kick-drain.ts). Still logged above, and
    // every other failure still throws.
    if (isConnectionExhaustion(err)) {
      return NextResponse.json({ error: 'db_unavailable' }, { status: 503 });
    }
    throw err;
  } finally {
    // Serverless flush: send buffered agent spans before the function returns.
    await flushTelemetry();
  }
});

async function runFirstReplyLeg(): Promise<FirstReplyRecoveryResult | { skipped: 'tick_failed' }> {
  try {
    const { firstReplyRecoveryDeps, runFirstReplyRecoveryCron } = await import(
      '~/lib/channel/intake/first-reply-recovery'
    );
    const { db } = await import('~/lib/db');
    const database = db();
    return await runFirstReplyRecoveryCron(database, firstReplyRecoveryDeps(database));
  } catch (err) {
    console.error({ err, skipped: 'tick_failed' }, 'cron/drain first-reply leg failed');
    return { skipped: 'tick_failed' };
  }
}
