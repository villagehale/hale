import { handlePreviewExperienceCard } from '~/lib/channel/preview-experience-card';

export const runtime = 'nodejs';

/** POST /api/channels/preview/experience-card — VIL-480 forced experience card, Preview only. */
export async function POST(req: Request): Promise<Response> {
  return handlePreviewExperienceCard(req);
}
