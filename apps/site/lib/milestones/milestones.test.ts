import { describe, expect, it } from 'vitest';
import {
  adjacentCheckpoints,
  allCheckpoints,
  checkpointForMonths,
  getCheckpoint,
  publishedCheckpoints,
} from './index';
import { checkpointJsonLd, hubJsonLd } from './structured-data';

/**
 * These are YMYL trust/safety invariants, not cosmetics: the tool describes an
 * age and can never grade a child, ships as unpublished review drafts, and the
 * birthday helper maps an age to the at-or-below checkpoint (never rounding up).
 * Expected values are derived from the CDC checkpoint set and those rules.
 */

const CDC_CHECKPOINT_MONTHS = [2, 4, 6, 9, 12, 15, 18, 24, 30, 36, 48, 60];

describe('milestone checkpoints', () => {
  it('ships the 12 CDC checkpoints in age order', () => {
    expect(allCheckpoints.map((c) => c.months)).toEqual(CDC_CHECKPOINT_MONTHS);
  });

  it('has unique, url-safe slugs', () => {
    const slugs = allCheckpoints.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('ships all 12 checkpoints published (review gate passed)', () => {
    expect(allCheckpoints.every((c) => c.published === true)).toBe(true);
    expect(publishedCheckpoints).toHaveLength(12);
  });

  it('gives every checkpoint all four CDC domains with real milestone copy', () => {
    const expectedDomains = [
      'social-emotional',
      'language-communication',
      'cognitive',
      'movement-physical',
    ];
    for (const c of allCheckpoints) {
      expect(c.domains.map((d) => d.domain)).toEqual(expectedDomains);
      for (const group of c.domains) {
        expect(group.items.length).toBeGreaterThan(0);
        for (const item of group.items) {
          expect(item.length).toBeGreaterThan(3);
        }
      }
    }
  });

  it('grounds every checkpoint in its own fetched CDC checkpoint URL', () => {
    for (const c of allCheckpoints) {
      expect(c.sourceUrl).toMatch(/^https:\/\/www\.cdc\.gov\/act-early\/milestones\//);
    }
  });

  it('renders milestones in they/them — never gendered pronouns', () => {
    const gendered = /\b(he|she|his|her|him|hers|herself|himself)\b/i;
    for (const c of allCheckpoints) {
      for (const group of c.domains) {
        for (const item of group.items) {
          expect(item).not.toMatch(gendered);
        }
      }
    }
  });

  it('never uses the word "behind" in reader-facing copy', () => {
    for (const c of allCheckpoints) {
      const text = [c.title, c.description, ...c.domains.flatMap((d) => d.items)].join(' ');
      expect(text.toLowerCase()).not.toContain('behind');
    }
  });
});

describe('checkpointForMonths — birthday helper maps at-or-below, never up', () => {
  it('returns the exact checkpoint when the age matches one', () => {
    expect(checkpointForMonths(18).slug).toBe('18-months');
    expect(checkpointForMonths(24).slug).toBe('2-years');
  });

  it('rounds DOWN to the checkpoint at or below the age, never up', () => {
    // 20 months sits between 18m and 24m → the 18-month list (reassurance),
    // never the 2-year list (which would manufacture false worry).
    expect(checkpointForMonths(20).slug).toBe('18-months');
    expect(checkpointForMonths(23).slug).toBe('18-months');
    expect(checkpointForMonths(11).slug).toBe('9-months');
  });

  it('floors ages below the youngest checkpoint to 2 months', () => {
    expect(checkpointForMonths(0).slug).toBe('2-months');
    expect(checkpointForMonths(1).slug).toBe('2-months');
  });

  it('caps ages above the oldest checkpoint at 5 years', () => {
    expect(checkpointForMonths(72).slug).toBe('5-years');
    expect(checkpointForMonths(200).slug).toBe('5-years');
  });
});

describe('adjacentCheckpoints — looking back / looking ahead', () => {
  it('links the neighbouring ages', () => {
    const { prev, next } = adjacentCheckpoints('18-months');
    expect(prev?.slug).toBe('15-months');
    expect(next?.slug).toBe('2-years');
  });

  it('has no previous at the youngest and no next at the oldest', () => {
    expect(adjacentCheckpoints('2-months').prev).toBeUndefined();
    expect(adjacentCheckpoints('5-years').next).toBeUndefined();
  });
});

describe('checkpointJsonLd', () => {
  const checkpoint = getCheckpoint('18-months');
  if (!checkpoint) throw new Error('fixture checkpoint missing');
  const graph = checkpointJsonLd(checkpoint) as {
    '@graph': Array<Record<string, unknown>>;
  };

  it('emits a MedicalWebPage/Article and a BreadcrumbList', () => {
    const article = graph['@graph'].find((n) =>
      (n['@type'] as string[]).includes?.('MedicalWebPage'),
    ) as { '@type': string[]; citation: Array<{ url: string }> };
    expect(article['@type']).toContain('Article');
    const crumbs = graph['@graph'].find((n) => n['@type'] === 'BreadcrumbList');
    expect(crumbs).toBeDefined();
  });

  it('cites this age’s exact CDC checkpoint URL', () => {
    const article = graph['@graph'][0] as { citation: Array<{ url: string }> };
    expect(article.citation[0]?.url).toBe(checkpoint.sourceUrl);
  });

  it('breadcrumbs from Milestones to this age', () => {
    const crumbs = graph['@graph'].find((n) => n['@type'] === 'BreadcrumbList') as {
      itemListElement: Array<{ name: string; position: number }>;
    };
    expect(crumbs.itemListElement[0]?.name).toBe('Milestones');
    expect(crumbs.itemListElement[1]?.name).toBe('Around 18 months');
  });
});

describe('hubJsonLd', () => {
  it('lists each checkpoint once, in the order given', () => {
    const list = hubJsonLd(allCheckpoints) as {
      itemListElement: Array<{ position: number; name: string }>;
    };
    expect(list.itemListElement).toHaveLength(allCheckpoints.length);
    expect(list.itemListElement[0]?.position).toBe(1);
    expect(list.itemListElement[0]?.name).toBe('Around 2 months');
  });
});
