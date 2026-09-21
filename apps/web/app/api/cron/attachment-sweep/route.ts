import { NextResponse } from 'next/server';
import { sweepExpiredForwards } from '~/lib/channel/email/forward-purge';
import { sweepUnlinkedAttachments } from '~/lib/coach/attachments';
import { cronRoute } from '~/lib/cron/auth';
import { db } from '~/lib/db';

// Node runtime: the sweep deletes bucket objects via the storage adapter + the
// postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/attachment-sweep — THE LIFECYCLE SWEEP: the bounded stores a parent's
 * inaction leaves behind, purged on the one schedule rather than one cron slot each.
 *
 * 1. Ask Hale attachments a parent uploaded but never sent (message_id still NULL) once
 *    they age past their TTL: the bytes leave the private 'family-docs' bucket AND the
 *    row is deleted with an immutable audit_log row (rules #1, #6). Without this, a
 *    pending upload of a child photo would linger in the bucket forever.
 * 2. Forwarded mail held against an unanswered allowlist question past 72h — the raw
 *    third-party document AND the question itself (VIL-352). The ask tells the parent in
 *    writing that Hale forgets it in three days; this is the sentence being true.
 *
 * Both run every time; a failure in one must not silently cancel the other, so each
 * summary is returned by name.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING — no DB read, no
 * storage delete.
 */
export const GET = cronRoute('attachment-sweep', async () => {
  const database = db();
  const summary = await sweepUnlinkedAttachments(database);
  if (summary.swept > 0) {
    console.info(
      { swept: summary.swept },
      'cron/attachment-sweep: purged stale unlinked attachments',
    );
  }

  const forwards = await sweepExpiredForwards(database);
  if (forwards.purged > 0 || forwards.senders > 0) {
    console.info(
      { purged: forwards.purged, senders: forwards.senders },
      'cron/attachment-sweep: purged forwarded mail held past the three-day promise',
    );
  }

  return NextResponse.json({ ok: true, ...summary, forwards }, { status: 200 });
});
