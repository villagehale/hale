import { describe, expect, it } from 'vitest';
import {
  ANCHOR_WINDOW_CHARS,
  pageCarriesSchedule,
  preparePage,
  quoteIsBackedBy,
} from './quote-match.mjs';

/**
 * THE REPLICA, HELD TO THE ORIGINAL'S OWN SUITE.
 *
 * `quote-match.mjs` mirrors apps/web/lib/channel/activity/quote-match.ts because the tsx
 * loader here cannot resolve the web app's `~/` alias. A replica with no test of its own
 * is the failure mode a replica already has one of: it reports PASS about a rule that has
 * drifted from the one production runs. So this file is quote-match.test.ts's cases,
 * ported — page, quotes and expectations unchanged.
 *
 * IT IS ALSO THE ONLY THING GATING THE TOKEN PASS. The synthesis corpus cannot reach it:
 * its fixture pages are short enough that the model quotes a grid row verbatim, pipes and
 * all, so reverting the runner to a verbatim-only check leaves all four fixtures green.
 * The rule that refused fifty-three published facts on 2026-08-24 is exercised here or
 * nowhere.
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
    expect(quoteIsBackedBy('$117.09 for 9 lessons (30 minute lesson)', PAGE)).toBe(false);
    expect(quoteIsBackedBy('$117.09 for 9 lessons (45 minute lesson)', PAGE)).toBe(true);
  });

  it('refuses a time lifted from another row of the same grid', () => {
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
    expect(quoteIsBackedBy('a sentence that is nowhere on that page', PAGE)).toBe(false);
    expect(quoteIsBackedBy('registration opens in the fall', PAGE)).toBe(false);
  });

  it('refuses a composite resting on one token, however real that token is', () => {
    expect(quoteIsBackedBy('$86.22', PAGE)).toBe(true);
    expect(quoteIsBackedBy('$86.22 per child, taxes included', PAGE)).toBe(false);
    expect(quoteIsBackedBy('Mondays and Thursdays through the fall', PAGE)).toBe(false);
  });

  it('matches across the spellings a page and a model disagree about', () => {
    expect(quoteIsBackedBy('Sat 9:00 a.m. - 9:30 a.m., Oct 3 - Nov 28', PAGE)).toBe(true);
    expect(quoteIsBackedBy('Mon  10:00AM\n -\t10:30AM,  Oct 05 – Dec 07', PAGE)).toBe(true);
  });

  it('holds the order the page printed', () => {
    expect(quoteIsBackedBy('Wednesdays 10:30-11:00AM, Oct 07 - Dec 02', PAGE)).toBe(true);
    expect(quoteIsBackedBy('Wednesdays 11:00-10:30AM, Oct 07 - Dec 02', PAGE)).toBe(false);
    expect(quoteIsBackedBy('Wednesdays 10:30-11:00AM, Dec 02 - Oct 07', PAGE)).toBe(false);
  });

  it('holds the window it documents', () => {
    const spread = preparePage(`$41.10 ${'filler word '.repeat(12)} 7:15PM`);
    expect('filler word '.repeat(12).length).toBeGreaterThan(ANCHOR_WINDOW_CHARS);
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
    const contact = preparePage('Questions? Call 905-877-4244, 10241 8 Line, Georgetown L7G 0J1.');
    expect(pageCarriesSchedule(contact)).toBe(false);
  });

  it('is true as soon as a single price or clock time is printed', () => {
    expect(pageCarriesSchedule(preparePage('Drop-in swim. Adult $4.00.'))).toBe(true);
    expect(pageCarriesSchedule(preparePage('Doors open at 9:15am.'))).toBe(true);
  });
});
