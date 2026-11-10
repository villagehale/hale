import { NextResponse } from 'next/server';
import { purgeExpiredCheckInNotes } from '~/lib/channel/checkin/notes';
import { sweepRosterRetention } from '~/lib/channel/linq/roster-retention';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';
import {
  type OPS_PAGE_VOCABULARY,
  type OpsPagerOutcome,
  pageOps,
} from '~/lib/monitoring/failure-page';
import { erasureGoogleLogLine, runDeletionSweep, sweepMessageRetention } from '~/lib/rights/delete';
import { sweepRecordRetention } from '~/lib/rights/record-retention';
import { remoteProfileDeleterFromEnv } from '~/lib/signup/browser-use/runner';
import { sweepExpiredProviderSessions } from '~/lib/signup/browser-use/vault';

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
 * roster's numbers ride on this same cron for the same reason, whatever the group flags
 * say. 0159 is what makes the number column nullable; the release UPDATE throws if it is
 * still NOT NULL.
 *
 * MESSAGE RETENTION IS NOT FLAG-GATED. A message body or transcript older than
 * 365 days is removed on this same hourly run (`sweepMessageRetention`). The
 * privacy promise is a year, and a promise that stops when a flag flips is not
 * a promise. The step logs counts only.
 *
 * NOR ARE THE RECORDS WITH NO CLOCK OF THEIR OWN (`sweepRecordRetention`): the words of
 * an episode a parent removed go thirty days after the removal, and a proactive candidate
 * row goes after a year. Counts only.
 *
 * PROVIDER SIGNUP SESSIONS ARE NOT FLAG-GATED EITHER. A captured provider login
 * (cookies, never a password) lives at most 48 hours; past that the row and its
 * Browser Use profile are deleted here. Without BROWSER_USE_API_KEY a row that
 * already seeded a remote profile waits (`remotePending`) instead of orphaning it.
 *
 * ONE STEP THAT THROWS NEVER SKIPS THE NEXT. Each step runs on its own: a throw is logged
 * by step and error name, paged to #ops (`retention_step_failed`), answered in place of
 * that step's counts as `{ failed: true, page }`, and the steps after it still run. The
 * route then answers 500, so the hour reads as failed while every other promise was kept.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING — no DB read,
 * no delete. The erased + purged-object counts are logged so the erasure (rows AND
 * storage bytes) is recorded durably, outside the rows the cascade removes (rule #6
 * note in runDeletionSweep).
 */
type Step = (typeof OPS_PAGE_VOCABULARY)['retention_step_failed']['step'][number];

type StepFailed = { failed: true; page: OpsPagerOutcome };

async function runStep<T>(step: Step, run: () => Promise<T>): Promise<T | StepFailed> {
  try {
    return await run();
  } catch (err) {
    // The error's name only: its message can echo a row (rule #1).
    console.error(
      { step, err: err instanceof Error ? err.name : 'unknown' },
      'cron/delete-sweep: a step threw; the steps after it still run',
    );
    const page = await pageOps(db(), { site: 'retention_step_failed', facts: { step } }).catch(
      (): OpsPagerOutcome => 'page_failed',
    );
    return { failed: true, page };
  }
}

function failed<T>(result: T | StepFailed): result is StepFailed {
  return typeof result === 'object' && result !== null && 'failed' in result;
}

export const GET = cronRoute('delete-sweep', async () => {
  const sweep = await runStep('deletion_sweep', () => runDeletionSweep(db()));
  const checkInNotesPurged = await runStep('check_in_notes', () => purgeExpiredCheckInNotes(db()));
  const messageRetention = await runStep('message_retention', () => sweepMessageRetention(db()));
  const recordRetention = await runStep('record_retention', () => sweepRecordRetention(db()));
  const groupRosterRetention = await runStep('roster_retention', () => sweepRosterRetention(db()));
  const providerSessions = await runStep('provider_sessions', () =>
    sweepExpiredProviderSessions(db(), new Date(), remoteProfileDeleterFromEnv()),
  );
  const anyFailed = [
    sweep,
    checkInNotesPurged,
    messageRetention,
    recordRetention,
    groupRosterRetention,
    providerSessions,
  ].some(failed);
  const summary = failed(sweep) ? null : sweep;
  const google = summary ? erasureGoogleLogLine(summary) : null;
  if (summary && summary.erased > 0) {
    console.info(
      { erased: summary.erased, purgedObjects: summary.purgedObjects },
      'cron/delete-sweep: erased families past grace',
    );
  }
  if (google) {
    // Counts and outcome codes only (rule #1): families kept for Google, erased past the
    // wait, the page that went to #ops, and each Google row's outcome.
    console.info(google, 'cron/delete-sweep: google grants of families due for erasure');
  }
  if (summary && summary.orphans.swept > 0) {
    // Counts only, never an id of the person the row is about (rule #1). Logged on its
    // own line because it is a different erasure with a different subject: the family
    // sweep above answers a REQUEST, and this one closes doors nobody asked about.
    console.info(summary.orphans, 'cron/delete-sweep: closed accounts no household holds');
  }
  if (
    !failed(messageRetention) &&
    Object.values(messageRetention).reduce((sum, count) => sum + count, 0) > 0
  ) {
    // Counts only (rule #1). The summary names how many rows each table lost
    // content from. It never carries a body, a number, or an address.
    console.info(messageRetention, 'cron/delete-sweep: removed message content past 12 months');
  }
  if (
    !failed(recordRetention) &&
    (recordRetention.removedEpisodesBlanked > 0 || recordRetention.proactiveCandidatesDeleted > 0)
  ) {
    // Counts only (rule #1).
    console.info(recordRetention, 'cron/delete-sweep: removed records past their window');
  }
  if (
    !failed(groupRosterRetention) &&
    groupRosterRetention.outcome === 'swept' &&
    (groupRosterRetention.familylessRostersDeleted > 0 || groupRosterRetention.numbersReleased > 0)
  ) {
    // Counts only (rule #1). The family-less deletions have no audit row to live in.
    console.info(groupRosterRetention, 'cron/delete-sweep: released group roster numbers');
  }
  if (
    !failed(providerSessions) &&
    (providerSessions.deleted > 0 ||
      providerSessions.remotePending > 0 ||
      providerSessions.remoteFailed > 0)
  ) {
    // Counts only (rule #1): never a host, a family, or a profile id.
    console.info(providerSessions, 'cron/delete-sweep: deleted provider sessions past 48 hours');
  }
  return NextResponse.json(
    {
      ok: !anyFailed,
      // Counts only, like the log lines: summary.google names each row by integration id.
      ...(summary
        ? {
            erased: summary.erased,
            purgedObjects: summary.purgedObjects,
            orphans: summary.orphans,
            google,
          }
        : { deletionSweep: sweep }),
      checkInNotesPurged,
      messageRetention,
      recordRetention,
      groupRosterRetention,
      providerSessions,
    },
    { status: anyFailed ? 500 : 200 },
  );
});
