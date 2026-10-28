import { NextResponse } from 'next/server';
import { runCarpoolReminders } from '~/lib/channel/linq/carpool';
import { linqGroupCarpoolEnabled } from '~/lib/channel/linq/config';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { flushTelemetry } from '~/lib/telemetry/langfuse';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * GET /api/cron/carpool-reminders — VIL-445 night-before driver reminder.
 * Auth is CRON_SECRET. The flag stays dark until Preview/ops set it.
 */
export const GET = cronRoute('carpool-reminders', async () => {
  try {
    if (!linqGroupCarpoolEnabled()) {
      return NextResponse.json({ ok: true, skipped: 'flag_off' }, { status: 200 });
    }
    const summary = await runCarpoolReminders(db(), { now: new Date() });
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } finally {
    await flushTelemetry();
  }
});
