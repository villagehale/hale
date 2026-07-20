import { NextResponse } from 'next/server';
import { sweepUnlinkedAttachments } from '~/lib/coach/attachments';
import { requireCronSecret } from '~/lib/cron/auth';
import { db } from '~/lib/db';

// Node runtime: the sweep deletes bucket objects via the storage adapter + the
// postgres driver (not edge).
export const runtime = 'nodejs';

/**
 * GET /api/cron/attachment-sweep — purges Ask Hale attachments a parent uploaded but
 * never sent (message_id still NULL) once they age past their TTL: the bytes leave the
 * private 'family-docs' bucket AND the row is deleted with an immutable audit_log row
 * (rules #1, #6). Without this, a pending upload of a child photo would linger in the
 * bucket forever.
 *
 * Cron-secret gated like every cron route: a request without the matching
 * `Authorization: Bearer <CRON_SECRET>` gets 401 and does NOTHING — no DB read, no
 * storage delete.
 */
export async function GET(req: Request) {
  const denied = requireCronSecret(req);
  if (denied) return denied;

  const summary = await sweepUnlinkedAttachments(db());
  if (summary.swept > 0) {
    console.info(
      { swept: summary.swept },
      'cron/attachment-sweep: purged stale unlinked attachments',
    );
  }
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
