import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_KEYS, parseAttribution, serializeAttribution } from './attribution.js';

// The attribution keys travel into Stripe metadata and analytics, so a value that is
// not a campaign or click token never survives the parse.

describe('parseAttribution value sanitizing', () => {
  it('keeps campaign and click tokens as they arrive (positive control)', () => {
    expect(
      parseAttribution(
        '?utm_source=google&utm_medium=cpc&utm_campaign=bf26 launch&utm_content=hero_v2&gclid=Cj0KCQ-abc_123.x~y&fbclid=IwAR1+z',
      ),
    ).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'bf26 launch',
      utm_content: 'hero_v2',
      gclid: 'Cj0KCQ-abc_123.x~y',
      fbclid: 'IwAR1 z',
    });
  });

  it('drops a value that carries an email address or a URL', () => {
    expect(
      parseAttribution(
        `?utm_source=newsletter&utm_content=${encodeURIComponent('parent@example.com')}&utm_term=${encodeURIComponent('https://evil.example/x?y=1')}`,
      ),
    ).toEqual({ utm_source: 'newsletter' });
  });

  it('drops markup and quotes from a loose body map', () => {
    expect(
      parseAttribution({
        utm_source: 'google',
        utm_campaign: '<script>alert(1)</script>',
        gclid: 'a"b',
      }),
    ).toEqual({ utm_source: 'google' });
  });

  it('bounds every value at 200 characters', () => {
    const long = 'a'.repeat(450);
    expect(parseAttribution(`gclid=${long}`).gclid).toHaveLength(200);
  });
});

describe('source_code', () => {
  it('is an attribution key', () => {
    expect(ATTRIBUTION_KEYS).toContain('source_code');
  });

  it('keeps a kebab source code and round-trips it through the cookie form', () => {
    const parsed = parseAttribution({ source_code: 'poster-oakville', utm_source: 'poster' });
    expect(parsed).toEqual({ source_code: 'poster-oakville', utm_source: 'poster' });
    expect(parseAttribution(serializeAttribution(parsed))).toEqual(parsed);
  });

  it('drops a source code outside the site grammar or longer than 48 characters', () => {
    expect(parseAttribution({ source_code: 'Poster Oakville' })).toEqual({});
    expect(parseAttribution({ source_code: 'parent@example.com' })).toEqual({});
    expect(parseAttribution({ source_code: `a-${'b'.repeat(47)}` })).toEqual({});
  });

  it('is not read from the site landing tag (`s=`), which the site validates itself', () => {
    expect(parseAttribution('s=poster-oakville')).toEqual({});
  });
});
