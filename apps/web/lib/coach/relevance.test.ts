import { describe, expect, it } from 'vitest';
import { rankTopK, relevanceScores, terms } from './relevance';

describe('relevance (VIL-144)', () => {
  it('splits unspaced scripts into bigrams and spaced ones into words', () => {
    expect(terms('王老师')).toEqual(['王老', '老师']);
    expect(terms('Juniper, EpiPen!')).toEqual(['juniper', 'epipen']);
    expect(terms('مرحبا بالعالم')).toEqual(['مرحبا', 'بالعالم']);
  });

  it('weights rare terms over common ones, with no word list', () => {
    const docs = ['the park the park', 'the sesame allergy', 'the library'];
    const s = relevanceScores(docs, { primary: 'the sesame' });
    expect(s[1]).toBeGreaterThan(s[0] ?? 0);
    expect(s[1]).toBeGreaterThan(s[2] ?? 0);
  });

  it('keeps input order when nothing matches (fallback ranking preserved)', () => {
    const items = ['a1 x', 'b2 y', 'c3 z'];
    expect(rankTopK(items, (i) => i, { primary: 'nothing here' }, 2)).toEqual(['a1 x', 'b2 y']);
  });

  it('pulls a matching old item into the top-K', () => {
    const items = [...Array.from({ length: 50 }, (_, i) => `filler ${i}`), 'juniper sesame'];
    expect(rankTopK(items, (i) => i, { primary: 'sesame?' }, 5)[0]).toBe('juniper sesame');
  });
});
