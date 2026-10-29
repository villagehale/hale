import { type Database, schema } from '@hale/db';
import { and, asc, eq, like, notExists, sql } from 'drizzle-orm';
import type { CapturedSend } from '~/lib/channel/preview-capture-transport';
import { isSyntheticProbeNumber } from '~/lib/channels/phone';

/**
 * VIL-466 · The capture transport's sink on a deployed Preview.
 *
 * A capture used to live only in the process that made it, and a reply is often
 * sent from a queue drain in another invocation, so a proof run could not read
 * what Hale wrote. Each capture is written to `preview_captured_sends` instead.
 *
 * Only `createPreviewCaptureTransport` calls this, and that transport refuses to
 * exist outside Preview or beside any Linq key or line. The database is loaded
 * lazily so importing the outbound seam never opens a connection.
 */
export async function persistCapturedSend(send: CapturedSend, database?: Database): Promise<void> {
  // Defence in depth beside the transport's own check: never store a real number.
  if (!isSyntheticProbeNumber(send.to)) {
    throw new Error('preview capture store refused: recipient_not_synthetic');
  }
  const target = database ?? (await import('~/lib/db')).db();
  const urls = send.mediaUrls ?? null;
  await target.insert(schema.previewCapturedSends).values({
    toE164: send.to,
    body: send.body,
    mediaUrls: urls,
    providerMessageId: send.providerMessageId,
    capturedAt: new Date(send.capturedAt),
  });
}

/** Every capture for one fictional number, oldest first. */
export async function readCapturedSends(database: Database, toE164: string) {
  return database
    .select({
      body: schema.previewCapturedSends.body,
      mediaUrls: schema.previewCapturedSends.mediaUrls,
      providerMessageId: schema.previewCapturedSends.providerMessageId,
      capturedAt: schema.previewCapturedSends.capturedAt,
    })
    .from(schema.previewCapturedSends)
    .where(eq(schema.previewCapturedSends.toE164, toE164))
    .orderBy(asc(schema.previewCapturedSends.capturedAt));
}

/**
 * Ledger rows that say a capture happened (provider id `preview-capture-…`) with
 * no row in `preview_captured_sends`, i.e. a persist that failed. The proof read-back
 * reports this beside the captured count so a lost write shows up as a mismatch.
 * Preview's database holds only fake families, so the count is not scoped further.
 */
export async function countUncapturedLedgerRows(database: Database): Promise<number> {
  const cm = schema.channelMessages;
  const rows = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(cm)
    .where(
      and(
        eq(cm.direction, 'out'),
        like(cm.providerMessageId, 'preview-capture-%'),
        notExists(
          database
            .select({ one: sql`1` })
            .from(schema.previewCapturedSends)
            .where(eq(schema.previewCapturedSends.providerMessageId, cm.providerMessageId)),
        ),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}
