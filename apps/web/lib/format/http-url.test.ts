import { describe, expect, it } from 'vitest';
import { parentFacingActivityUrl, safeHttpUrl } from './http-url';

describe('safeHttpUrl', () => {
  it('keeps absolute http(s)', () => {
    expect(safeHttpUrl('https://example.ca/a')).toBe('https://example.ca/a');
  });

  it('drops non-http schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('VIL-510 · parentFacingActivityUrl', () => {
  it('keeps a venue or listing https page', () => {
    expect(
      parentFacingActivityUrl(
        'https://www.haltonhillstoday.ca/local-news/halton-hills-happenings-oct-30-nov-1-spooky-weekend-events-listing-12956839',
      ),
    ).toContain('haltonhillstoday.ca');
  });

  it('drops Wikipedia and sister hosts', () => {
    expect(parentFacingActivityUrl('https://en.wikipedia.org/wiki/Halton_Hills_Public_Library')).toBeNull();
    expect(parentFacingActivityUrl('https://www.wikipedia.org/wiki/X')).toBeNull();
    expect(parentFacingActivityUrl('https://commons.wikimedia.org/wiki/File:X')).toBeNull();
  });

  it('still requires absolute http(s)', () => {
    expect(parentFacingActivityUrl('/relative')).toBeNull();
  });
});
