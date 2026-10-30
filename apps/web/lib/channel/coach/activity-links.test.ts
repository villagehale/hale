import { describe, expect, it } from 'vitest';
import { attachLinks, linkRef } from './activity-links';

const PAGE = 'https://www.torontopubliclibrary.ca/programs-and-classes/';
const OTHER = 'https://www.torontopubliclibrary.ca/robotics';

describe('linkRef', () => {
  it('is stable per URL and different across URLs', () => {
    expect(linkRef(PAGE)).toBe(linkRef(PAGE));
    expect(linkRef(PAGE)).not.toBe(linkRef(OTHER));
    expect(linkRef(PAGE)).toMatch(/^link-[0-9a-f]{6}$/);
  });
});

describe('attachLinks', () => {
  const links = [
    { ref: linkRef(PAGE), url: PAGE },
    { ref: linkRef(OTHER), url: OTHER },
  ];

  it('returns the page for each cited ref once, in citation order', () => {
    const out = attachLinks(
      `A [${linkRef(OTHER)}] and B [${linkRef(PAGE)}] and A again [${linkRef(OTHER)}].`,
      links,
    );
    expect(out.urls).toEqual([OTHER, PAGE]);
    expect(out.body).toBe('A and B and A again.');
  });

  it('removes every typed URL, including one a tool returned', () => {
    expect(attachLinks(`See ${PAGE} and https://made.up/page.`, links)).toEqual({
      body: 'See and.',
      urls: [],
    });
  });

  it('drops an unknown ref', () => {
    expect(attachLinks('Swim. [link-000000]', links)).toEqual({ body: 'Swim.', urls: [] });
  });

  it('does not attach a cited page that is not absolute https (VIL-501)', () => {
    const http = 'http://example.com/swim';
    expect(attachLinks(`Swim. [${linkRef(http)}]`, [{ ref: linkRef(http), url: http }])).toEqual({
      body: 'Swim.',
      urls: [],
    });
    expect(attachLinks('Swim. [link-abcdef]', [{ ref: 'link-abcdef', url: 'not-a-url' }])).toEqual({
      body: 'Swim.',
      urls: [],
    });
  });

  it('leaves the word ref in the prose', () => {
    expect(attachLinks('The ref is at the field at 4.', links).body).toBe(
      'The ref is at the field at 4.',
    );
    expect(attachLinks('A ref came back this time, so I can attach the page.', links).body).toBe(
      'A ref came back this time, so I can attach the page.',
    );
  });
});

describe('VIL-510 · only activity/venue pages reach a parent', () => {
  it('drops Wikipedia and other reference hosts', async () => {
    const { isActivityPageUrl } = await import('./activity-links');
    expect(isActivityPageUrl('https://en.wikipedia.org/wiki/Halton_Hills_Public_Library')).toBe(
      false,
    );
    expect(isActivityPageUrl('https://www.wikiwand.com/en/Georgetown,_Ontario')).toBe(false);
  });
  it('drops bare homepages and http', async () => {
    const { isActivityPageUrl } = await import('./activity-links');
    expect(isActivityPageUrl('https://www.hhpl.on.ca/')).toBe(false);
    expect(isActivityPageUrl('https://www.haltonhills.ca')).toBe(false);
    expect(isActivityPageUrl('http://example.org/events/halloween')).toBe(false);
  });
  it('keeps event listings and venue pages', async () => {
    const { isActivityPageUrl } = await import('./activity-links');
    expect(
      isActivityPageUrl(
        'https://www.haltonhillstoday.ca/local-news/halton-hills-happenings-oct-30-nov-1-spooky-weekend-events-listing-12956839',
      ),
    ).toBe(true);
    expect(isActivityPageUrl('https://www.hhpl.on.ca/events?type=kids')).toBe(true);
  });
  it('a cited Wikipedia ref attaches nothing', async () => {
    const { attachLinks, linkRef } = await import('./activity-links');
    const wiki = 'https://en.wikipedia.org/wiki/Halton_Hills_Public_Library';
    const out = attachLinks(`Library has stuff [${linkRef(wiki)}]`, [
      { ref: linkRef(wiki), url: wiki },
    ]);
    expect(out.urls).toEqual([]);
  });
});
