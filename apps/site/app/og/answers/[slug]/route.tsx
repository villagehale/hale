import { getAnswer } from '~/lib/answers/index';
import { renderShareCard } from '~/lib/site/share-card';
import { paintAnswerCard, shareCardQueryFromUrl } from '~/lib/site/share-cards';

export const runtime = 'nodejs';

/** Absolute article card: https://www.villagehale.com/og/answers/<slug>?v=d8&… */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const page = getAnswer(slug);
  if (!page) return new Response('Not found', { status: 404 });
  const image = renderShareCard(
    paintAnswerCard(page.question, shareCardQueryFromUrl(new URL(request.url))),
  );
  image.headers.set('Cache-Control', 'public, max-age=86400');
  return image;
}
