import { describe, expect, it } from 'vitest';
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

function brief(overrides: Partial<Parameters<typeof renderTravelBrief>[0]> = {}) {
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
  it('names the city, the days and two things, and claims nothing about having been', () => {
    const body = brief();
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

  it('fits four segments against the FULL opt-out form, in GSM-7', () => {
    const body = brief();
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_TRAVEL_BRIEF_SEGMENTS);
  });

  it('names the under-13s, and falls back generically when there are none to name', () => {
    expect(brief({ childNames: ['Mia', 'Leo'] })).toContain('for Mia and Leo:');
    // A teen-only household arrives here with an empty list and is answered generically —
    // which is the point: the teen's absence is indistinguishable from having no children.
    expect(brief({ childNames: [] })).toContain('for the kids:');
  });

  it('omits a clause the source never published, and invents nothing in its place', () => {
    const body = brief({ picks: [pick({ price: null }), ZOO] });
    expect(body).toContain('American Museum of Natural History - open daily 10am-5:30pm (their site).');
    expect(body).not.toContain('USD 28');
    // THE POSITIVE CONTROL: the same pick WITH a price renders it, so the absence above is
    // a claim about the null rather than about a renderer that never prints prices.
    expect(brief()).toContain('USD 28 adults / 16 kids');
  });

  it('renders a pick with neither a time nor a price rather than dropping it', () => {
    const body = brief({ picks: [pick({ when: null, price: null })] });
    expect(body).toContain('American Museum of Natural History (their site).');
  });

  it('carries at most two picks — the third is dropped, not linked', () => {
    const third = pick({ name: 'Brooklyn Childrens Museum', sourceName: 'Brooklyn Childrens Museum' });
    const body = brief({ picks: [pick(), ZOO, third] });
    expect(body).not.toContain('Brooklyn Childrens Museum');
  });

  /**
   * WHOLE-PICK-AT-A-TIME. A cut that lands inside "USD 2" publishes a wrong price, so a
   * pick that would not fit whole is dropped entire — asserted by the FIRST pick's
   * complete price string still being present.
   */
  it('drops a second pick whole rather than cutting one in half', () => {
    const long = pick({
      name: 'Long Island Childrens Museum and Discovery Centre at Mitchel Field',
      when:
        'Tuesday to Sunday 10am to 5pm, and every statutory holiday Monday as well, with the last admission half an hour before closing and the whole building shut for the first week of September',
      price:
        'USD 17 per person over one year old, members free, EBT card holders USD 3, and a family membership that covers two adults and up to four children for the year',
      sourceName: 'Long Island Childrens Museum',
    });
    const body = brief({ picks: [pick(), long] });
    expect(body).toContain('USD 28 adults / 16 kids (their site).');
    expect(body).not.toContain('USD 17');
    expect(body).not.toContain('USD 1');
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_TRAVEL_BRIEF_SEGMENTS);
  });

  it('throws rather than shortening when the body cannot be trusted', () => {
    // Nothing on: there is no honest one-line version of this text, so there is no text.
    expect(() => brief({ picks: [] })).toThrow(/no_picks/);
  });
});

describe('travelBriefViolations', () => {
  const context = {
    dayPhrase: 'the 12th to the 15th',
    rendered: [pick(), ZOO],
    teenNames: ['Ari'],
  };

  it('is empty for the body the composer produces', () => {
    expect(travelBriefViolations(brief(), context)).toEqual([]);
  });

  it("refuses a teen's name outright rather than trimming it", () => {
    const body = `${brief()} Ari is coming too.`;
    expect(travelBriefViolations(body, context)).toContain('names_a_teen');
  });

  it('refuses a digit that traces to nothing', () => {
    const body = brief().replace("That's off", "Roughly 40 minutes away. That's off");
    expect(travelBriefViolations(body, context)).toContain('unbacked_digit');
    // Positive control: the same body without the invented figure is clean, so the rule is
    // about the digit rather than about the sentence.
    expect(travelBriefViolations(brief(), context)).toEqual([]);
  });

  it('refuses a question the composer put outside a pick', () => {
    const body = `${brief()} Want anything else?`;
    expect(travelBriefViolations(body, context)).toContain('asks_a_question');
  });

  it('refuses a character that would halve the segment budget', () => {
    const body = brief().replace(' - ', ' — ');
    expect(travelBriefViolations(body, context)).toContain('not_gsm7');
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
