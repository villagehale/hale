import { NextResponse } from 'next/server';
import { linqMultiFamilyGroupsEnabled } from '~/lib/channel/linq/config';
import { deliverShared } from '~/lib/channel/linq/multi-family';
import { secretSantaEnabled, sharedSecretSantaLineWriter } from '~/lib/channel/linq/secret-santa';
import { runSecretSantaSweep } from '~/lib/channel/linq/secret-santa-send';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/secret-santa — VIL-686. Every five minutes, each drawn Secret Santa's
 * givers who have not had their draw get it 1:1 (daytime in their own zone, a healthy
 * line, a verified channel), a lost done line goes once, and the organizer hears once who
 * is still missing or that the draw went stale.
 *
 * Dark while SECRET_SANTA is `false` or multi-family groups are off. Retention is NOT here:
 * delete-sweep runs it whatever the flag says. Counts only in the response.
 */
export const GET = cronRoute('secret-santa', async () => {
  try {
    if (!secretSantaEnabled() || !linqMultiFamilyGroupsEnabled()) {
      return NextResponse.json({ ok: true, dark: true }, { status: 200 });
    }
    const summary = await runSecretSantaSweep(db(), new Date(), {
      writer: sharedSecretSantaLineWriter(),
      deliverGroup: deliverShared,
    });
    if (summary.draws > 0) console.info(summary, 'cron/secret-santa: swept');
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
});
