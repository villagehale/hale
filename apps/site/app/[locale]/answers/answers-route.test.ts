import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_SOURCES } from '~/lib/answers/frameworks.js';
import { allAnswers, getAnswer } from '~/lib/answers/index.js';
import { CONTACT_EMAIL } from '~/lib/text-entry.js';
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
  const element = await AnswerPageRoute({
    params: Promise.resolve({ slug, locale: 'en' as const }),
  });
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

  // Like the redesigned header, the server renders /text; the shared chooser
  // retargets phones after hydration. Missing-number deployments offer email.
  it('delegates its CTA to the shared front door rather than hardcoding one', async () => {
    for (const number of [LIVE_NUMBER, '']) {
      vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
      const html = await render(SLUG);
      expect(html).toContain(`href="${number ? '/text' : `mailto:${CONTACT_EMAIL}`}"`);
      expect(html).toContain(number ? 'Text Hale' : 'Email Hale');
    }
  });

  it('sends a reader to the texting door under the live config — never the deleted wizard', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const html = await render(SLUG);
    expect(html).toContain('href="/text"');
    expect(html).not.toContain('/onboarding');
  });

  it('restyles every guide while preserving the full published content and source links', async () => {
    const escaped = (text: string) =>
      renderToStaticMarkup(createElement('span', null, text)).slice(6, -7);
    for (const page of allAnswers) {
      const html = await render(page.slug);
      // Exclude JSON-LD so missing visible paragraphs cannot pass on SEO data alone.
      const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
      expect(visible.match(/<h1\b/g), page.slug).toHaveLength(1);
      expect(visible).toContain('design-marketing sp-article');
      expect(visible).toContain('shore-art');
      expect(visible).toContain('guide-doc');
      for (const text of [
        page.question,
        page.answer,
        ...page.keyTakeaways,
        ...page.sections.flatMap((section) => [section.heading, ...section.body]),
        ...page.faqs.flatMap((faq) => [faq.question, faq.answer]),
      ]) {
        expect(visible, page.slug).toContain(escaped(text));
      }
      for (const citation of page.citations) {
        const source = FRAMEWORK_SOURCES[citation.framework];
        expect(visible).toContain(escaped(source.label));
        expect(visible).toContain(escaped(citation.reference));
        if (citation.excerpt) expect(visible).toContain(escaped(citation.excerpt));
        if (source.home) expect(visible).toContain(`href="${source.home}"`);
      }
      for (const slug of page.related) expect(visible).toContain(`href="/answers/${slug}"`);
    }
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
