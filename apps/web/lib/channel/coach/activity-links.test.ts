import { describe, expect, it } from 'vitest';
import {
  attachLinks,
  classFactsFromTurn,
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

const TUMBLERS = 'https://www.haltonhills.ca/en/recreation/tiny-tumblers.aspx';
const STORY = 'https://www.torontopubliclibrary.ca/programs-and-classes/';

describe('ref narration never reaches a parent (VIL-501)', () => {
  const facts = [
    {
      name: 'Tiny Tumblers parent & tot',
      ageFit: 'walking to 3 years',
      when: 'Saturday mornings this fall',
      price: null,
      sourceName: 'Halton Hills',
      url: TUMBLERS,
    },
  ];

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

  it('replaces narration with every class this turn and only those pages', () => {
    const other = 'https://www.oakville.ca/recreation/swimming/learn-to-swim.html';
    const tumblers = facts[0];
    if (!tumblers) throw new Error('fixture fact missing');
    const out = repairParentReply(
      'A ref came back this time, so I can attach the page.',
      [],
      [
        tumblers,
        {
          name: 'Learn to Swim',
          ageFit: 'ages 3-5',
          when: 'Sundays 9:30',
          sourceName: 'Oakville',
          url: other,
        },
      ],
    );
    expect(out.body).toContain('Tiny Tumblers parent & tot');
    expect(out.body).toContain('Learn to Swim');
    expect(out.body).not.toMatch(/\brefs?\b/i);
    expect(out.urls).toEqual([TUMBLERS, other]);
    expect(out.body).not.toContain('https://invented.example');
  });

  it('replaces a narration-only reply with the class and its real page', () => {
    expect(
      repairParentReply('A ref came back this time, so I can attach the page.', [], facts),
    ).toEqual({
      body: 'Tiny Tumblers parent & tot, walking to 3 years, Saturday mornings this fall, per Halton Hills.',
      urls: [TUMBLERS],
    });
  });

  it('states the class and attaches no page when the tool had none', () => {
    const out = repairParentReply(
      'No refs came back.',
      [],
      [
        {
          name: 'Tiny Tumblers parent & tot',
          when: 'Saturday mornings',
          sourceName: 'Halton Hills',
        },
      ],
    );
    expect(out.body).toContain('Tiny Tumblers parent & tot');
    expect(out.body).toContain('Saturday mornings');
    expect(out.urls).toEqual([]);
    expect(out.body).not.toMatch(/https?:\/\//);
  });

  it('does not text a url that is not an absolute page', () => {
    const out = repairParentReply(
      'A ref came back.',
      [],
      [{ name: 'Tiny Tumblers parent & tot', url: 'not-a-url' }],
    );
    expect(out.body).toContain('Tiny Tumblers parent & tot');
    expect(out.urls).toEqual([]);
    expect(out.body).not.toContain('not-a-url');
  });

  it('keeps a class sentence, drops the narration, and adds that class page', () => {
    const out = repairParentReply(
      'A ref came back. Riverdale story time is Saturday at 10.',
      [],
      [{ name: 'Riverdale story time', when: 'Saturday at 10', url: STORY }],
    );
    expect(out.body).toBe('Riverdale story time is Saturday at 10.');
    expect(out.urls).toEqual([STORY]);
    expect(out.body).not.toMatch(/\brefs?\b/i);
  });

  it('leaves a reply that never narrated alone, even when a page exists', () => {
    expect(
      repairParentReply(
        'Riverdale story time is Saturday at 10.',
        [],
        [{ name: 'Riverdale story time', url: STORY }],
      ),
    ).toEqual({ body: 'Riverdale story time is Saturday at 10.', urls: [] });
  });

  it('keeps village facts and web facts once each', () => {
    expect(
      classFactsFromTurn(
        [{ title: 'Riverdale story time', venue: 'Toronto Public Library', url: STORY }],
        [{ name: 'Riverdale story time', sourceName: 'Toronto Public Library', url: STORY }],
      ),
    ).toEqual([
      {
        name: 'Riverdale story time',
        ageFit: null,
        when: null,
        price: null,
        sourceName: 'Toronto Public Library',
        url: STORY,
      },
    ]);
  });
});
