import { describe, expect, it } from 'vitest';
import {
  attributionIsEmpty,
  mergeFirstTouch,
  parseAttribution,
  serializeAttribution,
} from './attribution.js';

describe('parseAttribution', () => {
  it('reads utm_* plus gclid and fbclid from a query string', () => {
    expect(
      parseAttribution(
        '?utm_source=google&utm_medium=cpc&utm_campaign=holiday&utm_term=hale&utm_content=hero&gclid=Gw&fbclid=Fb',
      ),
    ).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'holiday',
      utm_term: 'hale',
      utm_content: 'hero',
      gclid: 'Gw',
      fbclid: 'Fb',
    });
  });

  it('ignores unrelated keys and empty values', () => {
    expect(parseAttribution('s=poster-oakville&utm_source=&gclid=')).toEqual({});
  });

  it('returns empty for null/undefined', () => {
    expect(parseAttribution(null)).toEqual({});
    expect(parseAttribution(undefined)).toEqual({});
  });
});

describe('mergeFirstTouch', () => {
  it('keeps the first source and fills later click ids', () => {
    const first = parseAttribution('utm_source=poster&utm_medium=qr');
    const later = parseAttribution('utm_source=google&gclid=Abc');
    expect(mergeFirstTouch(first, later)).toEqual({
      utm_source: 'poster',
      utm_medium: 'qr',
      gclid: 'Abc',
    });
  });
});

describe('serializeAttribution', () => {
  it('round-trips the known keys', () => {
    const original = parseAttribution('utm_source=google&gclid=X');
    expect(parseAttribution(serializeAttribution(original))).toEqual(original);
    expect(attributionIsEmpty(original)).toBe(false);
    expect(attributionIsEmpty({})).toBe(true);
  });
});
