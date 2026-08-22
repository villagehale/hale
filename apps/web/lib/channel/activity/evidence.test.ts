import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { FETCH_FRESHNESS_MS, namesAVenue, readEvidence } from './evidence';

/**
 * THE TEST FOR THE SENTENCE THAT CAUSED THE BENCHMARK DEFECT.
 *
 * "No dates or price up yet" is a claim about PAGES, and until this module there was no
 * value in the lane that knew whether any page had been opened. Everything here is the
 * positive control for that: a turn that read nothing must not be able to present as a
 * turn that read and found nothing.
 */

function block(partial: Record<string, unknown>): Anthropic.ContentBlock {
  return partial as unknown as Anthropic.ContentBlock;
}

const SEARCH_HIT = block({
  type: 'web_search_tool_result',
  content: [
    { type: 'web_search_result', title: 'Cartwheels Gym Centre - Programs', url: 'https://x.ca/p' },
  ],
});

const NOW = new Date('2026-08-22T21:00:00.000Z');

function fetched(url: string, data: string, retrievedAt = '2026-08-22T20:30:00.000000+00:00'): Anthropic.ContentBlock {
  return block({
    type: 'web_fetch_tool_result',
    content: {
      type: 'web_fetch_result',
      url,
      retrieved_at: retrievedAt,
      content: { type: 'document', source: { type: 'text', data } },
    },
  });
}

function refused(code: string): Anthropic.ContentBlock {
  return block({
    type: 'web_fetch_tool_result',
    content: { type: 'web_fetch_tool_result_error', error_code: code },
  });
}

describe('readEvidence', () => {
  it('counts a successful page fetch as a page read, and carries its url and text', () => {
    const evidence = readEvidence(NOW, [
      SEARCH_HIT,
      fetched('https://x.ca/programs.php', 'Schedule at a glance: Sundays 9:30 - 10:15'),
    ]);

    expect(evidence.pagesRead).toBe(1);
    expect(evidence.pagesRefused).toBe(0);
    expect(evidence.urlsRead).toEqual(['https://x.ca/programs.php']);
    expect(evidence.notes).toContain('Sundays 9:30 - 10:15');
  });

  it('counts a refused fetch as refused, NEVER as a page read', () => {
    // The whole point: url_not_allowed is the shape the live probe returned on the
    // benchmark venue's own schedule page. A turn that only ever got this has read
    // nothing, and must not be able to say a page lacks dates.
    const evidence = readEvidence(NOW, [SEARCH_HIT, refused('url_not_allowed')]);

    expect(evidence.pagesRead).toBe(0);
    expect(evidence.pagesRefused).toBe(1);
    expect(evidence.urlsRead).toEqual([]);
  });

  it('separates the two so a mixed turn reports both', () => {
    const evidence = readEvidence(NOW, [
      fetched('https://x.ca/a', 'one'),
      refused('url_not_accessible'),
      fetched('https://x.ca/b', 'two'),
    ]);

    expect(evidence.pagesRead).toBe(2);
    expect(evidence.pagesRefused).toBe(1);
  });

  it('counts real search results and ignores an errored search result block', () => {
    const errored = block({
      type: 'web_search_tool_result',
      content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    });

    expect(readEvidence(NOW, [SEARCH_HIT, errored]).searchResults).toBe(1);
  });

  it('keeps prose and tool_use arguments as notes - both are places the turn writes down', () => {
    const evidence = readEvidence(NOW, [
      block({ type: 'text', text: 'Found the fall grid.' }),
      block({ type: 'tool_use', name: 'activity_picks', input: { picks: [{ name: 'Tiny Gym' }] } }),
    ]);

    expect(evidence.notes).toContain('Found the fall grid.');
    expect(evidence.notes).toContain('Tiny Gym');
  });

  it('puts the fetched page text in the notes so the composer stands on the page, not the snippet', () => {
    const evidence = readEvidence(NOW, [
      block({ type: 'text', text: 'summary' }),
      fetched('https://x.ca/programs.php', 'Tiny Gym Sundays 9:30-10:15 $124 per term'),
    ]);

    expect(evidence.notes).toContain('https://x.ca/programs.php');
    expect(evidence.notes).toContain('$124 per term');
  });

  /**
   * A PAGE THE PROVIDER HANDED BACK FROM ITS CACHE IS NOT A PAGE READ TODAY.
   *
   * Live probe, 2026-08-22 21:17Z: three of four `web_fetch_result` blocks in one turn
   * carried `retrieved_at` of 16:17Z — a five-hour-old cached read — and the fourth was
   * fetched fresh. The field is real and the staleness is real, so the count that
   * licenses "their page doesn't say" has to know the difference: a schedule can go up
   * between the cached read and now, and Hale would report the cache as today's page.
   */
  describe('a stale read is not today', () => {
    it('counts a page retrieved past the freshness horizon as stale', () => {
      const old = new Date(NOW.getTime() - FETCH_FRESHNESS_MS - 60_000).toISOString();
      const evidence = readEvidence(NOW, [SEARCH_HIT, fetched('https://x.ca/p', 'grid', old)]);

      expect(evidence.pagesRead).toBe(1);
      expect(evidence.pagesStale).toBe(1);
    });

    it('POSITIVE CONTROL - the same page retrieved inside the horizon is not stale', () => {
      const recent = new Date(NOW.getTime() - FETCH_FRESHNESS_MS + 60_000).toISOString();
      const evidence = readEvidence(NOW, [SEARCH_HIT, fetched('https://x.ca/p', 'grid', recent)]);

      expect(evidence.pagesRead).toBe(1);
      expect(evidence.pagesStale).toBe(0);
    });

    it('treats a page with NO retrieved_at as stale - unknown age is not today', () => {
      const noStamp = block({
        type: 'web_fetch_tool_result',
        content: {
          type: 'web_fetch_result',
          url: 'https://x.ca/p',
          content: { type: 'document', source: { type: 'text', data: 'grid' } },
        },
      });

      expect(readEvidence(NOW, [SEARCH_HIT, noStamp]).pagesStale).toBe(1);
    });
  });
});

describe('namesAVenue', () => {
  it('is true for the two subjects the benchmark got wrong', () => {
    expect(namesAVenue('Cartwheels Gym Centre')).toBe(true);
    expect(namesAVenue('Gellert swim schedule')).toBe(true);
  });

  it('is false for a generic activity subject - no venue, no fetch budget', () => {
    expect(namesAVenue('toddler gymnastics')).toBe(false);
    expect(namesAVenue('indoor swim lessons this fall')).toBe(false);
  });

  it('is false when the only capitalised words are programme nouns', () => {
    // A model that title-cases its subject must not buy a fetch budget for it.
    expect(namesAVenue('Toddler Gymnastics')).toBe(false);
    expect(namesAVenue('Indoor Swim Lessons')).toBe(false);
  });

  it('is false for a subject with nothing in it', () => {
    expect(namesAVenue('')).toBe(false);
    expect(namesAVenue('   ')).toBe(false);
  });
});
