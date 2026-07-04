import { describe, expect, it } from 'vitest';
import { FRAMEWORK_SOURCES } from './frameworks';
import { allAnswers, getAnswer, publishedAnswers } from './index';
import { answerJsonLd } from './structured-data';

/**
 * The answer corpus is YMYL health content, so the invariants tested here are
 * the trust/safety ones, not cosmetics: every page is grounded in the permitted
 * frameworks, the reviewed set (and only that set) is published, and the
 * sitemap/index see only published pages. Expected values are derived from those
 * rules.
 */

// The pages a human has reviewed and cleared for indexing. Everything else must
// stay a noindex draft, out of the sitemap.
const PUBLISHED_SLUGS = [
  'newborn-sleep-fragmented',
  'newborn-safe-sleep-basics',
  'toddler-tantrums-how-to-handle',
  'child-homework-battles',
  'child-sibling-fighting',
  'newborn-cluster-feeding',
  'introducing-peanuts-to-baby',
  'starting-solids-when-ready',
  'toddler-biting-what-to-do',
  'toddler-separation-anxiety-daycare',
  'potty-training-readiness-signs',
  'toddler-screen-time-guidelines',
  'child-managing-screen-time',
  'teen-mental-health-warning-signs',
  'teen-setting-boundaries-autonomy',
];

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

  it('publishes exactly the human-reviewed set; every other page stays a draft (review-before-index gate)', () => {
    const published = publishedAnswers.map((a) => a.slug).sort();
    expect(published).toEqual([...PUBLISHED_SLUGS].sort());
    for (const page of allAnswers) {
      expect(page.published).toBe(PUBLISHED_SLUGS.includes(page.slug));
    }
  });

  it('grounds every published page in at least two citations, so nothing indexable is thinly sourced', () => {
    for (const page of publishedAnswers) {
      expect(page.citations.length).toBeGreaterThanOrEqual(2);
    }
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

  it('gives every page 2–4 substantial, quotable key takeaways', () => {
    for (const page of allAnswers) {
      expect(page.keyTakeaways.length).toBeGreaterThanOrEqual(2);
      expect(page.keyTakeaways.length).toBeLessThanOrEqual(4);
      for (const takeaway of page.keyTakeaways) {
        // Self-contained enough to quote out of context: a full sentence, not a fragment.
        expect(takeaway.length).toBeGreaterThan(40);
        expect(takeaway.trim()).toMatch(/[.!?]$/);
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

  const isArticle = (node: Record<string, unknown>): boolean => {
    const type = node['@type'];
    return Array.isArray(type) ? type.includes('Article') : type === 'Article';
  };

  it('emits a MedicalWebPage/Article and a FAQPage', () => {
    const article = graph['@graph'].find(isArticle);
    expect(article).toBeDefined();
    expect(article?.['@type']).toContain('MedicalWebPage');
    const types = graph['@graph'].map((node) => node['@type']);
    expect(types).toContain('FAQPage');
  });

  it('cites the page’s grounded frameworks in the Article node', () => {
    const article = graph['@graph'].find(isArticle) as {
      citation: Array<{ name: string }>;
    };
    expect(article.citation).toHaveLength(page.citations.length);
    const cited = article.citation.map((c) => c.name);
    for (const c of page.citations) {
      expect(cited).toContain(FRAMEWORK_SOURCES[c.framework].label);
    }
  });

  it('carries the E-E-A-T signals: a named publisher, dateModified, and reviewed-by authorities', () => {
    const article = graph['@graph'].find(isArticle) as {
      publisher: { name: string; legalName: string; logo: { url: string } };
      dateModified: string;
      reviewedBy: Array<{ name: string }>;
    };
    expect(article.publisher.name).toBe('Hale');
    expect(article.publisher.legalName).toBe('Village Hale Technologies Inc.');
    expect(article.publisher.logo.url).toMatch(/\/icon\.png$/);
    expect(article.dateModified).toBe(page.updated);
    expect(article.reviewedBy).toHaveLength(page.citations.length);
    const reviewers = article.reviewedBy.map((r) => r.name);
    for (const c of page.citations) {
      expect(reviewers).toContain(FRAMEWORK_SOURCES[c.framework].label);
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
