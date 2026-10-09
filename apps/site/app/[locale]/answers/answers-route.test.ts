import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allAnswers, getAnswer, publishedAnswers } from '~/lib/answers/index.js';
import { answerJsonLd } from '~/lib/answers/structured-data.js';
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

async function render(
  slug: string,
  locale: 'en' | 'fr' | 'zh' = 'en',
  searchParams?: { s?: string },
): Promise<string> {
  const element = await AnswerPageRoute({
    params: Promise.resolve({ slug, locale }),
    ...(searchParams ? { searchParams: Promise.resolve(searchParams) } : {}),
  });
  return renderToStaticMarkup(element);
}

/** The published guide body, frozen so a restyle cannot rewrite the copy. */
function publishedGuideCopyDigest(): string {
  const copy = publishedAnswers.map((page) => ({
    slug: page.slug,
    question: page.question,
    title: page.title,
    description: page.description,
    stage: page.stage,
    answer: page.answer,
    keyTakeaways: page.keyTakeaways,
    sections: page.sections,
    faqs: page.faqs,
    citations: page.citations.map((citation) => ({
      framework: citation.framework,
      reference: citation.reference,
      excerpt: citation.excerpt ?? null,
    })),
    related: page.related,
    updated: page.updated,
  }));
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

/** React's text escaping, so a word-for-word check survives apostrophes and ampersands. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
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
      // A live number paints /text (the client upgrades to sms:). No number is mailto.
      const door = href.startsWith('sms:') ? 'href="/text"' : href;
      expect(html).toContain(door);
      expect(html).toContain(label);
      if (href.startsWith('sms:')) expect(html).not.toContain('href="sms:');
    }
  });

  it('sends a reader to the texting door under the live config — never the deleted wizard', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const html = await render(SLUG);
    expect(chromeCta().href).toMatch(/^sms:/);
    expect(html).toContain('href="/text"');
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('/onboarding');
  });

  it('carries a validated ?s= code onto the guide door', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const html = await render(SLUG, 'en', { s: 'ab12' });
    expect(html).toContain('data-cta-placement="answer_detail"');
    expect(html).toContain('href="/text?s=ab12"');
    expect(html).not.toContain('href="sms:');
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

  it('keeps every published guide’s words, and the FAQPage graph, byte for byte', async () => {
    expect(publishedGuideCopyDigest()).toBe(
      '85ff788f168417f9630d3ead347333c2f1ad31a2565ea1ea25cc194b6ff399c6',
    );
    for (const page of publishedAnswers) {
      const html = await render(page.slug);
      expect(html, page.slug).toContain(escapeText(page.question));
      expect(html, page.slug).toContain(escapeText(page.answer));
      expect(html, page.slug).toContain(escapeText(page.description));
      for (const takeaway of page.keyTakeaways) {
        expect(html, page.slug).toContain(escapeText(takeaway));
      }
      for (const section of page.sections) {
        expect(html, page.slug).toContain(escapeText(section.heading));
        for (const paragraph of section.body) {
          expect(html, page.slug).toContain(escapeText(paragraph));
        }
      }
      const rows = html.match(/<details\b[^>]*>/g) ?? [];
      expect(rows, page.slug).toHaveLength(page.faqs.length);
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? '');
      expect(new Set(ids).size, page.slug).toBe(ids.length);
      for (const faq of page.faqs) {
        expect(html, page.slug).toContain(escapeText(faq.question));
        expect(html, page.slug).toContain(escapeText(faq.answer));
      }
      for (const tag of rows) {
        expect(tag, page.slug).toContain('class="hs-qa hs-acc"');
        expect(tag, page.slug).not.toMatch(/\sopen(?:=|\s|>)/);
        expect(tag, page.slug).not.toContain('name=');
      }
      const script = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(script, page.slug).toBeDefined();
      expect(JSON.parse(script ?? '{}')).toEqual(answerJsonLd(page));
    }
  });

  it('uses the new guide chrome in French and Chinese without translating the body', async () => {
    const page = getAnswer(SLUG);
    if (!page) throw new Error('fixture missing');
    const fr = await render(SLUG, 'fr');
    const zh = await render(SLUG, 'zh');
    expect(fr).toContain('En bref');
    expect(zh).toContain('简短回答');
    for (const html of [fr, zh]) {
      expect(html).toContain(escapeText(page.answer));
      expect(html).toContain(escapeText(page.question));
      expect(html).toContain('gd-h1');
      expect(html).toContain('gd-safety');
      expect(html).toContain('data-cta-placement="answer_detail"');
    }
    expect(fr).toContain('Sur cette page');
    expect(fr).toContain('Points clés');
    expect(fr).toContain('Guides parentaux');
    expect(zh).toContain('本页内容');
    expect(zh).toContain('要点速览');
    expect(zh).toContain('育儿指南');
  });
});
