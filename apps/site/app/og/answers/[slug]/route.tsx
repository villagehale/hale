import { getAnswer } from '~/lib/answers/index';
import { shareCardImage } from '~/lib/site/share-card';
import { answerShareCard } from '~/lib/site/share-cards';

export const runtime = 'nodejs';

/** Absolute article card: https://www.villagehale.com/og/answers/<slug> */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const page = getAnswer(slug);
  if (!page) return new Response('Not found', { status: 404 });
  return shareCardImage(answerShareCard(page.title));
}
