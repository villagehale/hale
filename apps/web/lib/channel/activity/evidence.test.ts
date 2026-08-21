import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { namesAVenue, readEvidence } from './evidence';

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

function fetched(url: string, data: string): Anthropic.ContentBlock {
  return block({
    type: 'web_fetch_tool_result',
    content: {
      type: 'web_fetch_result',
      url,
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
    const evidence = readEvidence([
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
    const evidence = readEvidence([SEARCH_HIT, refused('url_not_allowed')]);

    expect(evidence.pagesRead).toBe(0);
    expect(evidence.pagesRefused).toBe(1);
    expect(evidence.urlsRead).toEqual([]);
  });

  it('separates the two so a mixed turn reports both', () => {
    const evidence = readEvidence([
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

    expect(readEvidence([SEARCH_HIT, errored]).searchResults).toBe(1);
  });

  it('keeps prose and tool_use arguments as notes - both are places the turn writes down', () => {
    const evidence = readEvidence([
      block({ type: 'text', text: 'Found the fall grid.' }),
      block({ type: 'tool_use', name: 'activity_picks', input: { picks: [{ name: 'Tiny Gym' }] } }),
    ]);

    expect(evidence.notes).toContain('Found the fall grid.');
    expect(evidence.notes).toContain('Tiny Gym');
  });

  it('puts the fetched page text in the notes so the composer stands on the page, not the snippet', () => {
    const evidence = readEvidence([
      block({ type: 'text', text: 'summary' }),
      fetched('https://x.ca/programs.php', 'Tiny Gym Sundays 9:30-10:15 $124 per term'),
    ]);

    expect(evidence.notes).toContain('https://x.ca/programs.php');
    expect(evidence.notes).toContain('$124 per term');
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
