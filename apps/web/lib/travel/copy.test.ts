import { describe, expect, it } from 'vitest';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { withOptOut } from '~/lib/channel/opt-out';
import { smsSegments } from '~/lib/channel/sms-segments';
import {
  MAX_TRAVEL_BRIEF_SEGMENTS,
  picksNamedIn,
  travelBriefPicks,
  travelBriefViolations,
  tripDayPhrase,
} from './copy';

/**
 * The one text a trip gets. Nothing here writes a sentence any more (VIL-413 / VIL-417):
 * the whole body is the model's, so this file is the spec for the FACTS it is handed and
 * the LINT the spoken body must pass — which is what a reviewer can still diff.
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

/** A body the model might write, carrying every fact as published and the provenance in
 * its own words. The exact wording is the eval's business; the lint is this file's. */
const GOOD_BRIEF =
  "You're in New York the 12th to the 15th - a couple of things on for Mia and Leo. American Museum of Natural History, open daily 10am-5:30pm, USD 28 adults / 16 kids. Central Park Zoo, 10am-5pm, USD 20. That's off their own pages, not from anyone who's been.";

const CONTEXT = {
  dayPhrase: 'the 12th to the 15th',
  rendered: [pick(), ZOO],
  teenNames: ['Ari'],
};

describe('travelBriefPicks', () => {
  it('hands the model each pick as name, schedule and price in the lane order', () => {
    expect(travelBriefPicks([pick(), ZOO])).toEqual([
      {
        name: 'American Museum of Natural History',
        when: 'open daily 10am-5:30pm',
        price: 'USD 28 adults / 16 kids',
      },
      { name: 'Central Park Zoo', when: '10am-5pm', price: 'USD 20' },
    ]);
  });

  it('carries at most two — the third is dropped, not linked', () => {
    const third = pick({
      name: 'Brooklyn Childrens Museum',
      sourceName: 'Brooklyn Childrens Museum',
    });
    expect(travelBriefPicks([pick(), ZOO, third]).map((entry) => entry.name)).toEqual([
      'American Museum of Natural History',
      'Central Park Zoo',
    ]);
  });

  it('keeps a null clause null rather than inventing one', () => {
    expect(travelBriefPicks([pick({ price: null })])[0]).toEqual({
      name: 'American Museum of Natural History',
      when: 'open daily 10am-5:30pm',
      price: null,
    });
    // Nothing about the pick is passed that a parent cannot act on: no source name, no
    // age band of the lane's own.
    expect(Object.keys(travelBriefPicks([pick()])[0] ?? {})).toEqual(['name', 'when', 'price']);
  });
});

describe('picksNamedIn', () => {
  it('counts only the picks the body actually names — the receipt is about what was said', () => {
    const named = picksNamedIn(GOOD_BRIEF.replace('Central Park Zoo, 10am-5pm, USD 20. ', ''), [
      pick(),
      ZOO,
    ]);
    expect(named.map((entry) => entry.name)).toEqual(['American Museum of Natural History']);
    expect(picksNamedIn(GOOD_BRIEF, [pick(), ZOO])).toHaveLength(2);
  });
});

describe('travelBriefViolations', () => {
  it('is empty for a body that carries the facts and says whose they are', () => {
    expect(travelBriefViolations(GOOD_BRIEF, CONTEXT)).toEqual([]);
  });

  it('refuses a body that names no pick: there is no honest one-line version of this text', () => {
    expect(
      travelBriefViolations("You're in New York the 12th to the 15th, off their own pages.", {
        ...CONTEXT,
        rendered: [],
      }),
    ).toContain('no_picks');
  });

  it("refuses a teen's name outright rather than trimming it", () => {
    expect(travelBriefViolations(`${GOOD_BRIEF} Ari is coming too.`, CONTEXT)).toContain(
      'names_a_teen',
    );
  });

  /**
   * ON A WORD BOUNDARY, the outbound redactor's own — `nameAnywhere`, through
   * `namesAPerson`, so the set of names this refuses is exactly the set that one replaces.
   *
   * A substring match refuses the WHOLE text, so the cost of a false positive is a
   * household with a short teen name never getting a brief at all: a teen called Al makes
   * "Algonquin Outfitters" unsendable, and a teen called Ed does the same to "Edmonton".
   */
  it('reads a short teen name inside a longer word as the word, not the teen', () => {
    const outfitters = pick({ name: 'Algonquin Outfitters', sourceName: 'Algonquin Outfitters' });
    const short = { dayPhrase: 'the 12th to the 15th', rendered: [outfitters], teenNames: ['Al'] };
    const body =
      "You're in Huntsville the 12th to the 15th. Algonquin Outfitters, open daily 10am-5:30pm, USD 28 adults / 16 kids. That's off their own site.";
    expect(travelBriefViolations(body, short)).toEqual([]);

    // The positive control the negative above needs: the same teen, standing as a word.
    expect(travelBriefViolations(`${body} Al is coming too.`, short)).toContain('names_a_teen');
    // And a possessive is still the name — the boundary is a letter or a digit, not a
    // character class that lets an apostrophe smuggle one through.
    expect(travelBriefViolations(`${body} That's Al's week.`, short)).toContain('names_a_teen');
  });

  it('refuses a digit that traces to nothing', () => {
    const body = GOOD_BRIEF.replace("That's off", "Roughly 40 minutes away. That's off");
    expect(travelBriefViolations(body, CONTEXT)).toContain('unbacked_digit');
    // Positive control: the same body without the invented figure is clean, so the rule is
    // about the digit rather than about the sentence.
    expect(travelBriefViolations(GOOD_BRIEF, CONTEXT)).toEqual([]);
  });

  it("does not read a published price or schedule as the model's own digit", () => {
    // Every digit in GOOD_BRIEF sits inside a pick's `when` or `price` or the day phrase.
    expect(travelBriefViolations(GOOD_BRIEF, CONTEXT)).not.toContain('unbacked_digit');
    // And a pick that was NOT handed over does not get that pass: the same price with
    // the museum missing from `rendered` is an unbacked figure.
    expect(travelBriefViolations(GOOD_BRIEF, { ...CONTEXT, rendered: [ZOO] })).toContain(
      'unbacked_digit',
    );
  });

  it('refuses a question: there is no reply handler behind this text', () => {
    expect(travelBriefViolations(`${GOOD_BRIEF} Want anything else?`, CONTEXT)).toContain(
      'asks_a_question',
    );
  });

  /**
   * THE LANE'S DOCTRINE IN THE MODEL'S WORDS. A web pick has no field in which it could say
   * it was verified, so the body must say the details are off the venues' own pages. Any
   * phrasing that ties "their / its / own / the venues'" to a page, site or listing counts;
   * what is refused is a body that never says where the facts came from.
   */
  it('refuses a body that never says whose facts these are', () => {
    const silent = GOOD_BRIEF.replace(
      " That's off their own pages, not from anyone who's been.",
      '',
    );
    expect(travelBriefViolations(silent, CONTEXT)).toContain('no_provenance');
  });

  it('accepts a French provenance sentence', () => {
    const base = GOOD_BRIEF.replace(" That's off their own pages, not from anyone who's been.", '');
    const brief = `${base} Les détails viennent des sites, personne n'est allé vérifier sur place.`;
    const violations = travelBriefViolations(brief, CONTEXT);
    expect(violations).not.toContain('no_provenance');
    expect(violations).not.toContain('not_gsm7');
  });

  it('accepts the provenance in different words', () => {
    const base = GOOD_BRIEF.replace(" That's off their own pages, not from anyone who's been.", '');
    for (const closing of [
      " All from the venues' own sites.",
      ' Those details are straight off their websites.',
      " Hours and prices are the museums' own listings, nobody has been.",
      " That's what the pages of the venues themselves say.",
      ' From their own site, not a recommendation.',
    ]) {
      expect(travelBriefViolations(`${base}${closing}`, CONTEXT), closing).not.toContain(
        'no_provenance',
      );
    }
  });

  it('refuses a character that would halve the segment budget', () => {
    expect(travelBriefViolations(GOOD_BRIEF.replace(' - ', ' — '), CONTEXT)).toContain('not_gsm7');
  });

  it('refuses a body over four segments against the FULL opt-out form', () => {
    expect(smsSegments(withOptOut(GOOD_BRIEF, 'full'))).toBeLessThanOrEqual(
      MAX_TRAVEL_BRIEF_SEGMENTS,
    );
    const padded = `${GOOD_BRIEF} ${'Lovely place to walk around with the kids. '.repeat(12)}`;
    expect(travelBriefViolations(padded, CONTEXT)).toContain('too_many_segments');
  });
});

describe('tripDayPhrase', () => {
  it('says both days, and one day once', () => {
    expect(tripDayPhrase('2026-09-12', '2026-09-15')).toBe('the 12th to the 15th');
    expect(tripDayPhrase('2026-09-01', '2026-09-03')).toBe('the 1st to the 3rd');
    expect(tripDayPhrase('2026-09-22', '2026-09-22')).toBe('the 22nd');
  });

  it('gets the teens right, which is where an ordinal helper usually breaks', () => {
    expect(tripDayPhrase('2026-09-11', '2026-09-13')).toBe('the 11th to the 13th');
    expect(tripDayPhrase('2026-09-21', '2026-09-23')).toBe('the 21st to the 23rd');
    expect(tripDayPhrase('2026-09-30', '2026-10-02')).toBe('the 30th to the 2nd');
  });
});
