import { describe, expect, it } from 'vitest';
import {
  ANCHOR_WINDOW_CHARS,
  pageCarriesSchedule,
  preparePage,
  quoteIsBackedBy,
} from './quote-match';

/**
 * THE CHECK, TESTED ON THE BYTES THAT BROKE IT.
 *
 * `PAGE` below is the real Halton Hills swim-lessons page as the fetch pipeline extracted
 * it on 2026-08-24 — the two fee blocks and the Parent-and-Tot grid, verbatim, pipes and
 * all. The quotes are the ones the live synthesis actually returned. Every one of them was
 * refused as `quote_absent` while the grid sat on the page, and that is the whole reason
 * this module exists, so the fixture is the page and not a paraphrase of it.
 *
 * Each acceptance is paired with a refusal that differs from it by ONE fact — an hour, a
 * meridiem, a session code, a dollar figure. An accept-only suite would pass with a
 * function that returned `true`.
 */

const PAGE = preparePage(
  [
    'Gellert Evenings & Weekends - Fall Schedule',
    'Location: Gellert Community Centre, 10241 8 Line, Georgetown, 905-877-4244',
    'Fall 2026 Evening & Weekend Lessons: Saturday, October 3 to Monday December 7, 2026',
    'No Lessons:',
    'Monday October 12 (Thanksgiving) and Sunday October 11 (Evening classes only)',
    'Halton Hills Taxpayer Fees:',
    'P&T to Swimmer 3: $86.22 for 9 lessons (30 minute lesson)',
    'Swimmer 4-6: $117.09 for 9 lessons (45 minute lesson)',
    'Swimmer 7-9: $156.06 for 9 lessons (60 minute lesson)',
    'Semi Private: $203.76 for 9 semi-private lessons (30 minute lesson)',
    'Private: $393.57 for 9 private lessons (30 minute lesson)',
    'Program | Day | Time | Dates | code |',
    'Parent and Tot 1, 2, 3 | Mon | 10:00AM - 10:30AM | Oct 05 - Dec 07 | 108969 |',
    'Parent and Tot 1, 2, 3 | Wed | 10:00AM - 10:30AM | Oct 07 - Dec 02 | 109044 |',
    'Parent and Tot 1, 2, 3 | Wed | 10:30AM - 11:00AM | Oct 07 - Dec 02 | 109054 |',
    'Parent and Tot 1, 2, 3 | Fri | 10:00AM - 10:30AM | Oct 09 - Dec 04 | 109026 |',
    'Parent and Tot 1 | Tue | 6:30PM - 7:00PM | Oct 06 - Dec 01 | 109016 |',
    'Parent and Tot 1 | Wed | 5:30PM - 6:00PM | Oct 07 - Dec 02 | 108987 |',
    'Parent and Tot 1 | Sat | 9:00AM - 9:30AM | Oct 03 - Nov 28 | 108938 |',
    'Parent and Tot 1 | Sun | 11:00AM - 11:30AM | Oct 04 - Nov 29 | 109035 |',
    'Halton Hills taxpayers can register for Fall Recreation Programs beginning Tuesday,',
    'September 1 at 7 a.m.',
  ].join('\n'),
);

describe('quoteIsBackedBy', () => {
  it('backs the live grid quotes the verbatim check refused', () => {
    // Verbatim, these are on no page anywhere: the model read four table cells and wrote
    // them as one sentence. That is a faithful quote of a grid and it is what refusing
    // fifty-three true facts looked like.
    for (const quote of [
      'Mondays 10:00-10:30AM, Oct 05 - Dec 07 (code 108969)',
      'Wednesdays 10:30-11:00AM, Oct 07 - Dec 02 (code 109054)',
      'Saturdays 9:00-9:30AM, Oct 03 - Nov 28 (code 108938)',
      'Sundays 11:00-11:30AM, Oct 04 - Nov 29 (code 109035)',
      'Tuesdays 6:30-7:00PM, Oct 06 - Dec 01 (code 109016)',
    ]) {
      expect(PAGE.text.includes(quote.toLowerCase())).toBe(false);
      expect(quoteIsBackedBy(quote, PAGE)).toBe(true);
    }
  });

  it('backs a fee quote composed from a heading and the line under it', () => {
    expect(
      quoteIsBackedBy('$86.22 for 9 lessons (30 minute lesson), Halton Hills taxpayer fee', PAGE),
    ).toBe(true);
  });

  it('refuses a figure that is on no line of the page', () => {
    expect(quoteIsBackedBy('$310.00 for 9 lessons (30 minute lesson)', PAGE)).toBe(false);
  });

  it('refuses a fee that borrows its duration from a different line', () => {
    // $117.09 is real and IS "for 9 lessons" - but it is the 45-minute lesson, and the
    // "(30 minute lesson)" is lifted off the line above. Every token is on the page; the
    // sentence is not.
    expect(quoteIsBackedBy('$117.09 for 9 lessons (30 minute lesson)', PAGE)).toBe(false);
    expect(quoteIsBackedBy('$117.09 for 9 lessons (45 minute lesson)', PAGE)).toBe(true);
  });

  it('refuses a time lifted from another row of the same grid', () => {
    // 9:00-9:30AM is published - on Saturday, under code 108938. Attached to Monday's
    // 108969 it is a parent turning up on the wrong day at the wrong hour.
    expect(quoteIsBackedBy('Mondays 9:00-9:30AM, Oct 05 - Dec 07 (code 108969)', PAGE)).toBe(false);
  });

  it('refuses an AM class quoted as PM', () => {
    expect(quoteIsBackedBy('Mondays 10:00-10:30PM, Oct 05 - Dec 07 (code 108969)', PAGE)).toBe(
      false,
    );
    expect(quoteIsBackedBy('Mondays 10:00-10:30AM, Oct 05 - Dec 07 (code 108969)', PAGE)).toBe(
      true,
    );
  });

  it('refuses a swapped session code and a shifted date', () => {
    expect(quoteIsBackedBy('Mondays 10:00-10:30AM, Oct 05 - Dec 07 (code 999999)', PAGE)).toBe(
      false,
    );
    expect(quoteIsBackedBy('Mondays 10:00-10:30AM, Oct 12 - Dec 07 (code 108969)', PAGE)).toBe(
      false,
    );
  });

  it('still backs a span the page prints exactly', () => {
    expect(
      quoteIsBackedBy(
        'Halton Hills taxpayers can register for Fall Recreation Programs beginning Tuesday, September 1 at 7 a.m.',
        PAGE,
      ),
    ).toBe(true);
  });

  it('refuses a sentence with nothing countable in it', () => {
    // No money, no clock, no date, no code: there is nothing in this a checker could
    // stand on, so it is refused rather than waved through on prose.
    expect(quoteIsBackedBy('a sentence that is nowhere on that page', PAGE)).toBe(false);
    expect(quoteIsBackedBy('registration opens in the fall', PAGE)).toBe(false);
  });

  it('refuses a composite resting on one token, however real that token is', () => {
    // "$86.22" is on the page, so a span that IS that string is backed - a quote too
    // short to identify anything is refused a layer up, by MIN_QUOTE_CHARS. What this
    // refuses is the shape the token pass could otherwise wave through: a sentence the
    // page never printed, held up by a single figure lifted off it.
    expect(quoteIsBackedBy('$86.22', PAGE)).toBe(true);
    expect(quoteIsBackedBy('$86.22 per child, taxes included', PAGE)).toBe(false);
    expect(quoteIsBackedBy('Mondays and Thursdays through the fall', PAGE)).toBe(false);
  });

  it('matches across the spellings a page and a model disagree about', () => {
    expect(quoteIsBackedBy('Sat 9:00 a.m. - 9:30 a.m., Oct 3 - Nov 28', PAGE)).toBe(true);
    expect(quoteIsBackedBy('Mon  10:00AM\n -\t10:30AM,  Oct 05 – Dec 07', PAGE)).toBe(true);
  });

  it('holds the order the page printed', () => {
    // Both tokens are on the page and they are adjacent, so no window can tell these
    // apart - only the order can. A class that runs 10:30 to 11:00 is not a class that
    // runs 11:00 to 10:30, and a checker that sorted its tokens would say it was.
    expect(quoteIsBackedBy('Wednesdays 10:30-11:00AM, Oct 07 - Dec 02', PAGE)).toBe(true);
    expect(quoteIsBackedBy('Wednesdays 11:00-10:30AM, Oct 07 - Dec 02', PAGE)).toBe(false);
    expect(quoteIsBackedBy('Wednesdays 10:30-11:00AM, Dec 02 - Oct 07', PAGE)).toBe(false);
  });

  it('holds the window it documents', () => {
    // The gate is the distance between the tokens, so it is asserted rather than trusted:
    // a run of filler as long as the window separates a fact from a fabrication.
    const spread = preparePage(`$41.10 ${'filler word '.repeat(12)} 7:15PM`);
    expect(`${'filler word '.repeat(12)}`.length).toBeGreaterThan(ANCHOR_WINDOW_CHARS);
    expect(quoteIsBackedBy('$41.10 at 7:15PM', spread)).toBe(false);
    expect(quoteIsBackedBy('$41.10 at 7:15PM', preparePage('$41.10 at 7:15PM'))).toBe(true);
  });
});

describe('pageCarriesSchedule', () => {
  it('is true of the page that published the grid', () => {
    expect(pageCarriesSchedule(PAGE)).toBe(true);
  });

  it('is false of a page that announces a season and prints nothing', () => {
    const silent = preparePage(
      'Fall programs at Gellert Community Centre. The fall brochure will be available soon. Call 905-877-4244 or visit us at 10241 8 Line, Georgetown.',
    );
    expect(pageCarriesSchedule(silent)).toBe(false);
  });

  it('is not fooled into silence by a page whose only numbers are a phone and an address', () => {
    // A four-digit run out of a phone number tokenises like a session code, so codes are
    // deliberately not a schedule signal - otherwise "not posted yet" could never be said.
    const contact = preparePage('Questions? Call 905-877-4244, 10241 8 Line, Georgetown L7G 0J1.');
    expect(pageCarriesSchedule(contact)).toBe(false);
  });

  it('is true as soon as a single price or clock time is printed', () => {
    expect(pageCarriesSchedule(preparePage('Drop-in swim. Adult $4.00.'))).toBe(true);
    expect(pageCarriesSchedule(preparePage('Doors open at 9:15am.'))).toBe(true);
  });
});
