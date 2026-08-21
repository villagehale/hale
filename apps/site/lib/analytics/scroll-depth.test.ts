import { describe, expect, it } from 'vitest';
import { newlyCrossedDepths, scrolledFraction } from './scroll-depth';

/**
 * Expected values are derived from what the milestone MEANS — "this much of the page
 * has been in front of the reader" — not from what the arithmetic happens to return.
 */

describe('scrolledFraction', () => {
  it('measures from the bottom of the viewport, so the last pixel is 100%', () => {
    // 2000px document, 800px viewport: the reader can scroll 1200px, and at that point
    // the footer is on screen. scrollY alone would report 60%.
    expect(scrolledFraction({ scrollY: 1200, viewportHeight: 800, documentHeight: 2000 })).toBe(1);
  });

  it('reports the top of a long page as one viewport read', () => {
    expect(scrolledFraction({ scrollY: 0, viewportHeight: 800, documentHeight: 3200 })).toBe(0.25);
  });

  it('treats a page shorter than the viewport as fully read', () => {
    expect(scrolledFraction({ scrollY: 0, viewportHeight: 900, documentHeight: 600 })).toBe(1);
  });

  it('clamps rubber-band overscroll rather than reporting 110%', () => {
    expect(scrolledFraction({ scrollY: 1400, viewportHeight: 800, documentHeight: 2000 })).toBe(1);
    expect(scrolledFraction({ scrollY: -120, viewportHeight: 800, documentHeight: 4000 })).toBe(
      0.17,
    );
  });
});

describe('newlyCrossedDepths', () => {
  it('reports a milestone once and never again in the same view', () => {
    const sent = new Set<number>();
    expect(newlyCrossedDepths(0.3, sent)).toEqual([25]);
    sent.add(25);
    expect(newlyCrossedDepths(0.3, sent)).toEqual([]);
    expect(newlyCrossedDepths(0.49, sent)).toEqual([]);
  });

  it('reports every milestone a jump to the footer passed, in order', () => {
    expect(newlyCrossedDepths(1, new Set())).toEqual([25, 50, 75, 100]);
  });

  it('fills in the gap when a reader skips ahead after an earlier milestone', () => {
    expect(newlyCrossedDepths(1, new Set([25]))).toEqual([50, 75, 100]);
  });

  it('reports nothing above the fold', () => {
    expect(newlyCrossedDepths(0.2, new Set())).toEqual([]);
  });

  it('counts a depth as reached exactly at its boundary', () => {
    expect(newlyCrossedDepths(0.75, new Set([25, 50]))).toEqual([75]);
  });
});
