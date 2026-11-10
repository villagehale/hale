import { handlePreviewCapturedRead } from '~/lib/channel/preview-fake-inbound';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

/** GET /api/channels/preview/captured?to=… — VIL-466. Captured replies, Preview only. */
export async function GET(req: Request): Promise<Response> {
  return handlePreviewCapturedRead(req, { database: db() });
}
