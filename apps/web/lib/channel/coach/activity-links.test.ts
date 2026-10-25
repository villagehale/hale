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
});
