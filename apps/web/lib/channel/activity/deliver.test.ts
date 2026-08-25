import { describe, expect, it } from 'vitest';
import { watchWarranted } from './deliver';
import type { FollowUpPick } from './followup-note';

/**
 * IS THERE ANYTHING LEFT TO COME BACK FOR — the decision behind the watch row.
 *
 * It is read off the TOP pick, because the top pick is what the text leads with, and it
 * decides two things at once: whether Hale writes a continuation promise, and whether the
 * message is allowed to say it will come back. Every case here is a `price` or a `when` a
 * live extract really returned.
 */
function pick(over: Partial<FollowUpPick> = {}): FollowUpPick {
  return {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    ageFit: 'walking to 3.5 years',
    when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
    price: '$124 per term',
    registration: null,
    sourceName: 'Cartwheels Gym Centre',
    source: 'web',
    ...over,
  };
}

describe('watchWarranted', () => {
  it('is false for a find that carries both a day and a price', () => {
    expect(watchWarranted([pick()])).toBe(false);
  });

  it('is true with nothing found at all', () => {
    expect(watchWarranted([])).toBe(true);
  });

  it('is true when a field explains its own absence instead of being one', () => {
    // Live 2026-08-22, the venue this whole arc is named after.
    expect(
      watchWarranted([
        pick({
          price:
            'Not listed on main site; pricing varies by term length and is only visible after logging into the Registration Website',
        }),
      ]),
    ).toBe(true);
  });

  it('THE POLITE NON-ANSWER: a sentence about where a price lives is not a price', () => {
    // Live 2026-08-24. This claims no absence at all - it is perfectly cheerful - and it
    // answers nothing. It passed only because the old absence regex matched the "nt" in
    // "current"; once that bug was fixed Hale began handing it over as a complete find
    // with no follow-up behind it, and the parent had neither a price nor a promise.
    expect(
      watchWarranted([
        pick({ price: 'Fees set by Council each year, published in the current Recreation Guide' }),
      ]),
    ).toBe(true);
    expect(watchWarranted([pick({ when: 'Fall session, dates to be confirmed' })])).toBe(true);
  });

  it('FREE IS A PRICE - and demanding a figure made five free drop-ins look unanswered', () => {
    // Measured across the eval corpus's twenty-six top picks: requiring a figure moved
    // six, and five of them were free. A parent told "it's free" has the whole answer,
    // and a watch row to go back for the fee is Hale promising to answer nothing.
    expect(watchWarranted([pick({ price: 'Free' })])).toBe(false);
    expect(watchWarranted([pick({ price: 'Free drop-in, no registration' })])).toBe(false);
    // ...but "free" is not a WHEN. A session described as free play still has no day.
    expect(watchWarranted([pick({ when: 'Free play', price: '$124 per term' })])).toBe(true);
  });

  it('POSITIVE CONTROL - a partial figure is still a figure', () => {
    // The gate must not become "only a perfect field counts", or every find grows a watch
    // and the sentence that promises one stops meaning anything.
    expect(watchWarranted([pick({ when: 'Sundays', price: '$124' })])).toBe(false);
    expect(watchWarranted([pick({ when: 'Starts Sept 14', price: '$124 per term' })])).toBe(false);
  });
});
