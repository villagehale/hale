import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_URL } from '~/lib/app-url.js';
import { getAnswer } from '~/lib/answers/index.js';
import AnswerPageRoute, { generateMetadata, generateStaticParams } from './[slug]/page.js';

/**
 * The slug route is the public YMYL surface. These assertions lock the three
 * things that must hold for every draft: the page renders its answer + JSON-LD,
 * an unreviewed (unpublished) page is noindexed, and the sign-up funnel is wired.
 * Rendered to static markup so no browser/DOM is needed.
 */

const SLUG = 'introducing-peanuts-to-baby';

async function render(slug: string): Promise<string> {
  const element = await AnswerPageRoute({ params: Promise.resolve({ slug }) });
  return renderToStaticMarkup(element);
}

describe('answers/[slug] route', () => {
  it('statically generates a param for every page in the corpus', async () => {
    const params = await generateStaticParams();
    const slugs = params.map((p) => p.slug);
    expect(slugs).toContain(SLUG);
    expect(slugs).toContain('teen-mental-health-warning-signs');
  });

  it('renders the known page with its answer and FAQPage JSON-LD', async () => {
    const page = getAnswer(SLUG);
    if (!page) throw new Error('fixture missing');
    const html = await render(SLUG);

    expect(html).toContain(page.answer);
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('"@type":"Article"');
    // A grounded source must be surfaced on the page, not just in the graph.
    expect(html).toContain('Canadian Paediatric Society');
  });

  it('carries the "not medical advice" YMYL framing', async () => {
    const html = await render(SLUG);
    expect(html.toLowerCase()).toContain('not medical advice');
  });

  it('wires the "Ask Hale about your child" CTA to the app sign-up', async () => {
    const html = await render(SLUG);
    expect(html).toContain(`${APP_URL}/sign-up`);
    expect(html).toContain('Ask Hale about your child');
  });

  it('noindexes an unpublished (unreviewed) page', async () => {
    const held = 'toddler-separation-anxiety-daycare';
    expect(getAnswer(held)?.published).toBe(false);
    const meta = await generateMetadata({ params: Promise.resolve({ slug: held }) });
    expect(meta.robots).toMatchObject({ index: false });
    expect(meta.alternates?.canonical).toBe(`/answers/${held}`);
  });

  it('leaves a published (reviewed) page index-able', async () => {
    const published = 'newborn-sleep-fragmented';
    expect(getAnswer(published)?.published).toBe(true);
    const meta = await generateMetadata({ params: Promise.resolve({ slug: published }) });
    expect(meta.robots).toBeUndefined();
    expect(meta.alternates?.canonical).toBe(`/answers/${published}`);
  });
});
