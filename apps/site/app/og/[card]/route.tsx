import { renderShareCard } from '~/lib/site/share-card';
import { isShareCardId, paintShareCard, shareCardQueryFromUrl } from '~/lib/site/share-cards';

export const runtime = 'nodejs';

/** Absolute share images: https://www.villagehale.com/og/<card>?v=d4&… */
export async function GET(
  request: Request,
  context: { params: Promise<{ card: string }> },
): Promise<Response> {
  const { card } = await context.params;
  if (!isShareCardId(card)) return new Response('Not found', { status: 404 });
  const image = renderShareCard(paintShareCard(card, shareCardQueryFromUrl(new URL(request.url))));
  image.headers.set('Cache-Control', 'public, max-age=86400');
  return image;
}
