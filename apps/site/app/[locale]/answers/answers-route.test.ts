import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allAnswers, getAnswer } from '~/lib/answers/index.js';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import AnswerPageRoute, { generateMetadata, generateStaticParams } from './[slug]/page.js';

const LIVE_NUMBER = '+16475551234';

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The slug route is the public YMYL surface. These assertions lock the three
 * things that must hold for every draft: the page renders its answer + JSON-LD,
 * an unreviewed (unpublished) page is noindexed, and its CTA reaches the site's
 * front door. Rendered to static markup so no browser/DOM is needed.
 */

const SLUG = 'introducing-peanuts-to-baby';

async function render(slug: string): Promise<string> {
  const element = await AnswerPageRoute({ params: Promise.resolve({ slug, locale: 'en' as const }) });
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
    expect(html).toContain('"MedicalWebPage","Article"');
    // A grounded source must be surfaced on the page, not just in the graph.
    expect(html).toContain('Canadian Paediatric Society');
  });

  it('renders the marked Key takeaways block with the page’s takeaways verbatim', async () => {
    const page = getAnswer(SLUG);
    if (!page) throw new Error('fixture missing');
    const html = await render(SLUG);

    expect(html).toContain('Key takeaways');
    for (const takeaway of page.keyTakeaways) {
      expect(html).toContain(takeaway);
    }
  });

  it('carries the "not medical advice" YMYL framing', async () => {
    const html = await render(SLUG);
    expect(html.toLowerCase()).toContain('not medical advice');
  });

  it('presents the library as Parenting guides without changing its /answers URLs', async () => {
    const html = await render(SLUG);
    expect(html).toContain('Parenting guides');
    expect(html).toContain('Related guides');
    expect(html).toContain('href="/answers"');
  });

  /**
   * The guide's CTA delegates to the SAME front-door helper the site chrome uses,
   * rather than hardcoding a door of its own. That is the whole fix: the page used to
   * hardcode the app's /onboarding wizard, which no longer exists, so an acquisition
   * page's only action 308'd the reader back to the marketing homepage — a funnel in
   * a circle.
   *
   * Run against both configs the helper can be in (number provisioned, and not), so a
   * page that re-hardcoded either URL fails on the other.
   */
  it('delegates its CTA to the shared front door rather than hardcoding one', async () => {
    for (const number of [LIVE_NUMBER, '']) {
      vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
      const html = await render(SLUG);
      const { href, label } = chromeCta();
      // The sms href carries a `&`, which the renderer escapes in the attribute.
      expect(html).toContain(href.replace(/&/g, '&amp;'));
      expect(html).toContain(label);
    }
  });

  it('sends a reader to the texting door under the live config — never the deleted wizard', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const html = await render(SLUG);
    expect(chromeCta().href).toMatch(/^sms:/);
    expect(html).toContain(`sms:${LIVE_NUMBER}`);
    expect(html).not.toContain('/onboarding');
  });

  it('noindexes every unpublished (unreviewed) page (review-before-index gate)', async () => {
    const held = allAnswers.filter((a) => !a.published);
    for (const page of held) {
      const meta = await generateMetadata({
        params: Promise.resolve({ slug: page.slug, locale: 'en' as const }),
      });
      expect(meta.robots).toMatchObject({ index: false });
      expect(meta.alternates?.canonical).toBe(`/answers/${page.slug}`);
    }
  });

  it('leaves a published (reviewed) page index-able', async () => {
    const published = 'newborn-sleep-fragmented';
    expect(getAnswer(published)?.published).toBe(true);
    const meta = await generateMetadata({
      params: Promise.resolve({ slug: published, locale: 'en' as const }),
    });
    expect(meta.robots).toBeUndefined();
    expect(meta.alternates?.canonical).toBe(`/answers/${published}`);
  });
});
