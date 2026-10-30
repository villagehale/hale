import { describe, expect, it } from 'vitest';
import {
  attachLinks,
  linkRef,
  narratesRefMachinery,
  repairParentReply,
  stripRefNarration,
} from './activity-links';

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

const STORY = 'https://www.torontopubliclibrary.ca/programs-and-classes/';

describe('ref narration is stripped and never replaced (VIL-501)', () => {
  it('treats the machinery word as narration and leaves refer alone', () => {
    expect(narratesRefMachinery('A ref came back this time, so I can attach the page.')).toBe(true);
    expect(narratesRefMachinery('I can attach the page.')).toBe(true);
    expect(narratesRefMachinery('No refs came back.')).toBe(true);
    expect(narratesRefMachinery('Text this if you want to refer a friend.')).toBe(false);
    expect(narratesRefMachinery('Riverdale story time is Saturday at 10.')).toBe(false);
  });

  it('drops the narration sentence and keeps St. Lawrence whole', () => {
    expect(stripRefNarration('Meet at St. Lawrence. A ref came back.')).toBe(
      'Meet at St. Lawrence.',
    );
    expect(stripRefNarration('A ref came back this time, so I can attach the page.')).toBe('');
  });

  it('leaves an empty body when the reply was only narration, and does not write a class', () => {
    const out = repairParentReply('A ref came back this time, so I can attach the page.', [STORY]);
    expect(out.body).toBe('');
    expect(out.body).not.toMatch(/per /);
    expect(out.urls).toEqual([STORY]);
  });

  it('keeps the class the model wrote and drops the narration, without adding an uncited page', () => {
    const out = repairParentReply('A ref came back. Riverdale story time is Saturday at 10.', []);
    expect(out).toEqual({ body: 'Riverdale story time is Saturday at 10.', urls: [] });
  });

  it('keeps a cited https page beside the class the model wrote', () => {
    const out = repairParentReply('A ref came back. Riverdale story time is Saturday at 10.', [
      STORY,
    ]);
    expect(out.body).toBe('Riverdale story time is Saturday at 10.');
    expect(out.urls).toEqual([STORY]);
  });

  it('drops a cited page that is not absolute https', () => {
    const http = 'http://example.com/swim';
    expect(repairParentReply('Swim is Tuesday.', [http, 'not-a-url'])).toEqual({
      body: 'Swim is Tuesday.',
      urls: [],
    });
    expect(attachLinks(`Swim. [${linkRef(http)}]`, [{ ref: linkRef(http), url: http }])).toEqual({
      body: 'Swim.',
      urls: [],
    });
  });
});
