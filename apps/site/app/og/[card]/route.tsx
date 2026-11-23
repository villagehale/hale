import { shareCardImage } from '~/lib/site/share-card';
import { SHARE_CARDS, isShareCardId } from '~/lib/site/share-cards';

export const runtime = 'nodejs';

/** Absolute share images: https://www.villagehale.com/og/<card> */
export async function GET(
  _request: Request,
  context: { params: Promise<{ card: string }> },
): Promise<Response> {
  const { card } = await context.params;
  if (!isShareCardId(card)) return new Response('Not found', { status: 404 });
  return shareCardImage(SHARE_CARDS[card]);
}
