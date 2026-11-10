import { handlePreviewGroupCapturedRead } from '~/lib/channel/preview-fake-group-inbound';
import { db } from '~/lib/db';

export const runtime = 'nodejs';

/** GET /api/channels/preview/group-captured?chatId=preview-chat-… — VIL-466 groups. Preview only. */
export async function GET(req: Request): Promise<Response> {
  return handlePreviewGroupCapturedRead(req, { database: db() });
}
