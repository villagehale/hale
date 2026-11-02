import { handlePreviewAppClipPay } from '~/lib/channel/preview-app-clip-pay';

export const runtime = 'nodejs';

/** POST /api/channels/preview/app-clip-pay — VIL-481 sandbox App Clip card, Preview only. */
export async function POST(req: Request): Promise<Response> {
  return handlePreviewAppClipPay(req);
}
