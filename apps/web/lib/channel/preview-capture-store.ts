import { type Database, schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import type { CapturedSend } from '~/lib/channel/preview-capture-transport';

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
