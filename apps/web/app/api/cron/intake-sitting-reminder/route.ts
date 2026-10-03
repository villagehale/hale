import { NextResponse } from 'next/server';
import { runFirstReplyRecoveryCron } from '~/lib/channel/intake/first-reply-recovery';
import { createFriendVoiceComposer } from '~/lib/channel/intake/friend-voice';
import { onboardingFriendVoiceEnabled } from '~/lib/channel/intake/friend-voice-flag';
import {
  defaultSittingReminderDeps,
  runSittingReminderCron,
} from '~/lib/channel/intake/sitting-reminder';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';

// Node runtime: the sweep reaches the session store and the Twilio send, neither of
// which runs on the edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/intake-sitting-reminder — VIL-324 + VIL-332.
 *
 * Hourly Vercel Cron. Two jobs, one schedule (the existing minute-8 slot):
 *   - VIL-332 same-day first-hello recovery — every hour, no clock gate.
 *     A session that got a SID and no outbound cannot wait until 8am.
 *   - VIL-324 next-morning Still here — only in the Toronto morning hour.
 *
 * Sitting sessions stay intakes — this route does not provision a family.
 *
 * Cron-secret gated: a request without `Authorization: Bearer <CRON_SECRET>`
 * gets 401 and NOTHING runs.
 */
export const GET = cronRoute('intake-sitting-reminder', async () => {
  const database = db();
  const firstReply = await runFirstReplyRecoveryCron(database);
  const sitting = await runSittingReminderCron(
    database,
    onboardingFriendVoiceEnabled()
      ? {
          ...defaultSittingReminderDeps(),
          friendVoice: createFriendVoiceComposer(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS)),
        }
      : defaultSittingReminderDeps(),
  );
  return NextResponse.json({ ok: true, ...sitting, firstReply }, { status: 200 });
});
