import { handlePreviewVoiceMemo } from '~/lib/channel/preview-voice-memo';

export const runtime = 'nodejs';

/** POST /api/channels/preview/voice-memo — VIL-476 forced voice memo, Preview only. */
export async function POST(req: Request): Promise<Response> {
  return handlePreviewVoiceMemo(req);
}
