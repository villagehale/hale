import { NextResponse } from 'next/server';
import { purgeExpiredCheckInNotes } from '~/lib/channel/checkin/notes';
import { sweepRosterRetention } from '~/lib/channel/linq/roster-retention';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import { runDeletionSweep, sweepMessageRetention } from '~/lib/rights/delete';

// Node runtime: the sweep deletes via the postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/delete-sweep — the closing leg of the reversible-by-grace account
 * deletion (PIPEDA/Law 25 erasure). Hard-deletes every family whose grace window
 * has elapsed; the families FK cascade erases that family's data in one DELETE.
 * Until the grace lapses the stamp can be cleared to cancel, so this sweep only
 * ever erases families that have been scheduled AND waited out the window.
 *
 * IT ALSO DESTROYS EXPIRED RAW CONTENT, which is the other half of the same obligation
 * (Law 25: destroy once the purpose is achieved). The evening check-in's day notes carry
 * a thirty-day stamp and are purged here rather than on their own feature's cron for one
 * reason: that cron is behind the F14 dark-launch flag, and a retention promise that
 * stops being kept when a feature flag flips is not a retention promise. The Linq group
 * roster's numbers ride on this same cron, but only while group onboarding v2 is on.
 * Flag off the call returns `flag_off` and releases nothing, which is today's sweep.
 * 0158 and 0159 have to be applied together before that flag goes on: 0159 is what
 * makes the number column nullable, and the release UPDATE throws if it is still NOT NULL.
 *
 * MESSAGE RETENTION IS NOT FLAG-GATED. A message body or transcript older than
 * 365 days is removed on this same hourly run (`sweepMessageRetention`). The
 * privacy promise is a year, and a promise that stops when a flag flips is not
 * a promise. The step logs counts only.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING — no DB read,
 * no delete. The erased + purged-object counts are logged so the erasure (rows AND
 * storage bytes) is recorded durably, outside the rows the cascade removes (rule #6
 * note in runDeletionSweep).
 */
export const GET = cronRoute('delete-sweep', async () => {
  const summary = await runDeletionSweep(db());
  const checkInNotesPurged = await purgeExpiredCheckInNotes(db());
  const messageRetention = await sweepMessageRetention(db());
  const groupRosterRetention = await sweepRosterRetention(db());
  if (summary.erased > 0) {
    console.info(
      { erased: summary.erased, purgedObjects: summary.purgedObjects },
      'cron/delete-sweep: erased families past grace',
    );
  }
  if (summary.orphans.swept > 0) {
    // Counts only, never an id of the person the row is about (rule #1). Logged on its
    // own line because it is a different erasure with a different subject: the family
    // sweep above answers a REQUEST, and this one closes doors nobody asked about.
    console.info(summary.orphans, 'cron/delete-sweep: closed accounts no household holds');
  }
  const messagesRemoved = Object.values(messageRetention).reduce((sum, count) => sum + count, 0);
  if (messagesRemoved > 0) {
    // Counts only (rule #1). The summary names how many rows each table lost
    // content from. It never carries a body, a number, or an address.
    console.info(messageRetention, 'cron/delete-sweep: removed message content past 12 months');
  }
  if (
    groupRosterRetention.outcome === 'swept' &&
    (groupRosterRetention.familylessRostersDeleted > 0 || groupRosterRetention.numbersReleased > 0)
  ) {
    // Counts only (rule #1). The family-less deletions have no audit row to live in.
    console.info(groupRosterRetention, 'cron/delete-sweep: released group roster numbers');
  }
  return NextResponse.json(
    { ok: true, ...summary, checkInNotesPurged, messageRetention, groupRosterRetention },
    { status: 200 },
  );
});
