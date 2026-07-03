import { describe, expect, it } from 'vitest';
import { FRAMEWORK_SOURCES } from './frameworks';
import { allAnswers, getAnswer, publishedAnswers } from './index';
import { answerJsonLd } from './structured-data';

/**
 * The answer corpus is YMYL health content, so the invariants tested here are
 * the trust/safety ones, not cosmetics: every page is grounded in the permitted
 * frameworks, ships as a review-ready draft (unpublished), and the sitemap/index
 * see only published pages. Expected values are derived from those rules.
 */

describe('answer corpus', () => {
  it('ships ~15 curated pages', () => {
    expect(allAnswers.length).toBeGreaterThanOrEqual(15);
  });

  it('has unique, url-safe slugs', () => {
    const slugs = allAnswers.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('ships every page as an unpublished review draft (review-before-index gate)', () => {
    expect(allAnswers.every((a) => a.published === false)).toBe(true);
    expect(publishedAnswers.length).toBe(0);
  });

  it('grounds every page in at least one permitted framework with a real reference', () => {
    for (const page of allAnswers) {
      expect(page.citations.length).toBeGreaterThan(0);
      for (const citation of page.citations) {
        expect(FRAMEWORK_SOURCES[citation.framework]).toBeDefined();
        expect(citation.reference.length).toBeGreaterThan(10);
      }
    }
  });

  it('points every related slug at a page that exists', () => {
    for (const page of allAnswers) {
      for (const related of page.related) {
        expect(getAnswer(related)).toBeDefined();
      }
    }
  });
});

describe('answerJsonLd', () => {
  const page = getAnswer('toddler-tantrums-how-to-handle');
  if (!page) throw new Error('fixture page missing');
  const graph = answerJsonLd(page) as {
    '@graph': Array<Record<string, unknown>>;
  };

  it('emits an Article and a FAQPage', () => {
    const types = graph['@graph'].map((node) => node['@type']);
    expect(types).toContain('Article');
    expect(types).toContain('FAQPage');
  });

  it('cites the page’s grounded frameworks in the Article node', () => {
    const article = graph['@graph'].find((n) => n['@type'] === 'Article') as {
      citation: Array<{ name: string }>;
    };
    expect(article.citation).toHaveLength(page.citations.length);
    const cited = article.citation.map((c) => c.name);
    for (const c of page.citations) {
      expect(cited).toContain(FRAMEWORK_SOURCES[c.framework].label);
    }
  });

  it('leads the FAQ with the page’s own question and answer', () => {
    const faq = graph['@graph'].find((n) => n['@type'] === 'FAQPage') as {
      mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }>;
    };
    expect(faq.mainEntity[0]?.name).toBe(page.question);
    expect(faq.mainEntity[0]?.acceptedAnswer.text).toBe(page.answer);
    expect(faq.mainEntity).toHaveLength(page.faqs.length + 1);
  });
});
