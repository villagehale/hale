import { describe, expect, it } from 'vitest';
import type { ActivityReference } from '~/lib/channel/activity/facts';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { withOptOut } from '~/lib/channel/opt-out';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import {
  MAX_TRAVEL_BRIEF_SEGMENTS,
  renderTravelBrief,
  travelBriefViolations,
  tripDayPhrase,
} from './copy';

/**
 * The one text a trip gets. This file IS the spec: the tests assert the strings, so a
 * change to what a family reads on holiday is a reviewable diff.
 */

function pick(overrides: Partial<ActivityPick> = {}): ActivityPick {
  return {
    name: 'American Museum of Natural History',
    ageFit: 'all ages',
    when: 'open daily 10am-5:30pm',
    price: 'USD 28 adults / 16 kids',
    sourceName: 'American Museum of Natural History',
    source: 'web',
    ...overrides,
  };
}

const ZOO = pick({
  name: 'Central Park Zoo',
  when: '10am-5pm',
  price: 'USD 20',
  sourceName: 'Central Park Zoo',
});

const REFERENCE: ActivityReference = {
  name: 'Discovery Club',
  sourceName: 'City Museum',
  sourceUrl: 'https://example.org/discovery',
  ageFit: 'ages 2-5',
  when: '2020-09-12 10:00',
  price: '$14',
  status: 'unconfirmed',
  evidence: {
    program: 'Discovery Club',
    age: null,
    sessions: [],
    schedule: null,
    price: null,
    history: null,
    windowConfirmed: false,
  },
};

/** The BODY, which is what all but one of these tests are about. The render's other half
 * — which picks actually made it in — has its own test below. */
async function brief(overrides: Partial<Parameters<typeof renderTravelBrief>[0]> = {}) {
  return (await renderBrief(overrides)).body;
}

async function renderBrief(overrides: Partial<Parameters<typeof renderTravelBrief>[0]> = {}) {
  return renderTravelBrief({
    city: 'New York',
    startsOn: '2026-09-12',
    endsOn: '2026-09-15',
    childNames: ['Mia'],
    picks: [pick(), ZOO],
    teenNames: [],
    ...overrides,
  });
}

describe('renderTravelBrief', () => {
  it('uses the locked group opening and does not guess who is travelling', async () => {
    const body = await brief({ forGroup: true });
    expect(
      body.startsWith('Trip: New York, the 12th to the 15th. A couple of things on for Mia:'),
    ).toBe(true);
    expect(body).not.toContain("You're in");
  });

  it('names the city, the days and two things, and claims nothing about having been', async () => {
    const body = await brief();
    expect(body).toBe(
      "You're in New York the 12th to the 15th. A couple of things on for Mia: " +
        'American Museum of Natural History - open daily 10am-5:30pm, USD 28 adults / 16 kids ' +
        '(their site). Central Park Zoo - 10am-5pm, USD 20 (their site). ' +
        "That's off their own pages, not from anyone who's been.",
    );
    // No link, and no question: there is no reply handler behind this text, and a question
    // with nothing behind it is the recorded 2026-08-22 defect.
    expect(body).not.toContain('http');
    expect(body).not.toContain('?');
  });

  it('fits four segments against the FULL opt-out form, in GSM-7', async () => {
    const body = await brief();
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_TRAVEL_BRIEF_SEGMENTS);
  });

  it('names the under-13s, and falls back generically when there are none to name', async () => {
    expect(await brief({ childNames: ['Mia', 'Leo'] })).toContain('for Mia and Leo:');
    // A teen-only household arrives here with an empty list and is answered generically —
    // which is the point: the teen's absence is indistinguishable from having no children.
    expect(await brief({ childNames: [] })).toContain('for the kids:');
  });

  it('omits a clause the source never published, and invents nothing in its place', async () => {
    const body = await brief({ picks: [pick({ price: null }), ZOO] });
    expect(body).toContain(
      'American Museum of Natural History - open daily 10am-5:30pm (their site).',
    );
    expect(body).not.toContain('USD 28');
    // THE POSITIVE CONTROL: the same pick WITH a price renders it, so the absence above is
    // a claim about the null rather than about a renderer that never prints prices.
    expect(await brief()).toContain('USD 28 adults / 16 kids');
  });

  it('renders a pick with neither a time nor a price rather than dropping it', async () => {
    const body = await brief({ picks: [pick({ when: null, price: null })] });
    expect(body).toContain('American Museum of Natural History (their site).');
  });

  it('carries at most two picks — the third is dropped, not linked', async () => {
    const third = pick({
      name: 'Brooklyn Childrens Museum',
      sourceName: 'Brooklyn Childrens Museum',
    });
    const render = await renderBrief({ picks: [pick(), ZOO, third] });
    expect(render.body).not.toContain('Brooklyn Childrens Museum');
    // AND IT SAYS SO. `rendered` is what the sweep's audit row counts; counting the picks
    // the LANE handed up instead put a three on the receipt for a text that named two.
    expect(render.rendered.map((entry) => entry.name)).toEqual([
      'American Museum of Natural History',
      'Central Park Zoo',
    ]);
  });

  /**
   * WHOLE-PICK-AT-A-TIME. A cut that lands inside "USD 2" publishes a wrong price, so a
   * pick that would not fit whole is dropped entire — asserted by the FIRST pick's
   * complete price string still being present.
   */
  it('drops a second pick whole rather than cutting one in half', async () => {
    const long = pick({
      name: 'Long Island Childrens Museum and Discovery Centre at Mitchel Field',
      when: 'Tuesday to Sunday 10am to 5pm, and every statutory holiday Monday as well, with the last admission half an hour before closing and the whole building shut for the first week of September',
      price:
        'USD 17 per person over one year old, members free, EBT card holders USD 3, and a family membership that covers two adults and up to four children for the year',
      sourceName: 'Long Island Childrens Museum',
    });
    const render = await renderBrief({ picks: [pick(), long] });
    const body = render.body;
    expect(body).toContain('USD 28 adults / 16 kids (their site).');
    expect(body).not.toContain('USD 17');
    expect(body).not.toContain('USD 1');
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_TRAVEL_BRIEF_SEGMENTS);
    // A pick dropped for length is a pick the receipt must not count either.
    expect(render.rendered).toHaveLength(1);
  });

  it('throws rather than shortening when the body cannot be trusted', async () => {
    // Nothing on: there is no honest one-line version of this text, so there is no text.
    await expect(brief({ picks: [] })).rejects.toThrow(/no_picks/);
  });

  it('names an unconfirmed reference with its source, not a current recommendation', async () => {
    const rendered = await renderBrief({ picks: [], references: [REFERENCE] });
    expect(rendered.body).toContain('Places to check for Mia:');
    expect(rendered.body).toContain(
      'Discovery Club (City Museum): dates and age fit not confirmed for your trip.',
    );
    expect(rendered.body).not.toContain('things on');
    expect(rendered.body).toContain('These are source listings, not confirmed plans.');
    expect(rendered.body).not.toContain('off their own pages');
    for (const rejected of ['2020', '10:00', '$14', 'ages 2-5', 'https://']) {
      expect(rendered.body).not.toContain(rejected);
    }
    expect(rendered.rendered).toEqual([]);
    expect(rendered.renderedReferences).toEqual([REFERENCE]);
  });

  it('labels a historical reference as an older listing', async () => {
    const rendered = await renderBrief({
      picks: [],
      references: [{ ...REFERENCE, status: 'historical' }],
    });
    expect(rendered.body).toContain(
      'Discovery Club (City Museum): older listing; not confirmed for your trip.',
    );
    expect(rendered.body).not.toContain('2020');
    expect(rendered.rendered).toHaveLength(0);
    expect(rendered.renderedReferences).toHaveLength(1);
  });

  it('prioritizes supported picks and shares their two-slot ceiling with references', async () => {
    const rendered = await renderBrief({
      picks: [pick()],
      references: [REFERENCE, { ...REFERENCE, name: 'Another Club' }],
    });
    expect(rendered.rendered).toHaveLength(1);
    expect(rendered.renderedReferences).toEqual([REFERENCE]);
    expect(rendered.body).not.toContain('Another Club');
    expect(rendered.body.indexOf(pick().name)).toBeLessThan(rendered.body.indexOf(REFERENCE.name));
    expect((await renderBrief({ references: [REFERENCE] })).renderedReferences).toEqual([]);
  });

  it('refuses rather than leaking a teen named in a reference or its source', async () => {
    for (const reference of [
      { ...REFERENCE, name: 'Ari Discovery Club' },
      { ...REFERENCE, sourceName: "Ari's Museum" },
    ]) {
      await expect(
        brief({ picks: [], references: [reference], teenNames: ['Ari'] }),
      ).rejects.toThrow(/names_a_teen/);
    }
  });

  it('keeps reference-only group copy neutral and drops over-budget references whole', async () => {
    const rendered = await renderBrief({
      picks: [],
      references: [REFERENCE, { ...REFERENCE, name: 'Long name '.repeat(100) }],
      forGroup: true,
    });
    expect(rendered.body).toContain(
      'Trip: New York, the 12th to the 15th. Places to check for Mia:',
    );
    expect(rendered.body).not.toContain('Long name');
    expect(rendered.renderedReferences).toEqual([REFERENCE]);
    expect(smsSegments(withOptOut(rendered.body, 'full'))).toBeLessThanOrEqual(
      MAX_TRAVEL_BRIEF_SEGMENTS,
    );
    expect(
      await brief({ picks: [], references: [{ ...REFERENCE, name: 'Club — Museum' }] }),
    ).toContain('Club — Museum');
  });

  it('keeps the opening neutral when a long supported pick leaves only a reference', async () => {
    const rendered = await renderBrief({
      picks: [pick({ name: 'Long name '.repeat(100) })],
      references: [REFERENCE],
    });
    expect(rendered.rendered).toEqual([]);
    expect(rendered.renderedReferences).toEqual([REFERENCE]);
    expect(rendered.body).not.toContain('things on');
    expect(rendered.body).toContain('Places to check');
  });
});

describe('travelBriefViolations', () => {
  const context = {
    dayPhrase: 'the 12th to the 15th',
    rendered: [pick(), ZOO],
    teenNames: ['Ari'],
  };

  it('is empty for the body the composer produces', async () => {
    expect(travelBriefViolations(await brief(), context)).toEqual([]);
  });

  it("refuses a teen's name outright rather than trimming it", async () => {
    const body = `${await brief()} Ari is coming too.`;
    expect(travelBriefViolations(body, context)).toContain('names_a_teen');
  });

  /**
   * ON A WORD BOUNDARY, the outbound redactor's own — `nameAnywhere`, through
   * `namesAPerson`, so the set of names this refuses is exactly the set that one replaces.
   *
   * A substring match refuses the WHOLE text, so the cost of a false positive is a
   * household with a short teen name never getting a brief at all: a teen called Al makes
   * "Algonquin Outfitters" unsendable, and a teen called Ed does the same to "Edmonton".
   */
  it('reads a short teen name inside a longer word as the word, not the teen', async () => {
    const outfitters = pick({
      name: 'Algonquin Outfitters',
      sourceName: 'Algonquin Outfitters',
    });
    const short = { dayPhrase: 'the 12th to the 15th', rendered: [outfitters], teenNames: ['Al'] };
    const body = await brief({ picks: [outfitters], teenNames: ['Al'] });
    expect(travelBriefViolations(body, short)).toEqual([]);

    // The positive control the negative above needs: the same teen, standing as a word.
    expect(travelBriefViolations(`${body} Al is coming too.`, short)).toContain('names_a_teen');
    // And a possessive is still the name — the boundary is a letter or a digit, not a
    // character class that lets an apostrophe smuggle one through.
    expect(travelBriefViolations(`${body} That's Al's week.`, short)).toContain('names_a_teen');
  });

  it('refuses a digit that traces to nothing', async () => {
    const body = (await brief()).replace("That's off", "Roughly 40 minutes away. That's off");
    expect(travelBriefViolations(body, context)).toContain('unbacked_digit');
    // Positive control: the same body without the invented figure is clean, so the rule is
    // about the digit rather than about the sentence.
    expect(travelBriefViolations(await brief(), context)).toEqual([]);
  });

  it('refuses a question the composer put outside a pick', async () => {
    const body = `${await brief()} Want anything else?`;
    expect(travelBriefViolations(body, context)).toContain('asks_a_question');
  });

  it('sends a typographic dash', async () => {
    const body = (await brief()).replace(' - ', ' — ');
    expect(travelBriefViolations(body, context)).not.toContain('not_gsm7');
  });
});

describe('tripDayPhrase', () => {
  it('says both days, and one day once', async () => {
    expect(tripDayPhrase('2026-09-12', '2026-09-15')).toBe('the 12th to the 15th');
    expect(tripDayPhrase('2026-09-01', '2026-09-03')).toBe('the 1st to the 3rd');
    expect(tripDayPhrase('2026-09-22', '2026-09-22')).toBe('the 22nd');
  });

  it('gets the teens right, which is where an ordinal helper usually breaks', async () => {
    expect(tripDayPhrase('2026-09-11', '2026-09-13')).toBe('the 11th to the 13th');
    expect(tripDayPhrase('2026-09-21', '2026-09-23')).toBe('the 21st to the 23rd');
    expect(tripDayPhrase('2026-09-30', '2026-10-02')).toBe('the 30th to the 2nd');
  });
});
