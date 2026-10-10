import { describe, expect, it } from 'vitest';
import { borrowedFindDates, clausesOf, dateSource } from './borrowed-find-dates.mjs';

const STORY = dateSource('Central Library story time', 'Sat, Aug 8');
const FARM = dateSource('Riverdale Farm visit', 'Sun, Aug 9');

describe('clausesOf', () => {
  it('keeps a weekday comma inside the date and splits the next find', () => {
    expect(
      clausesOf(
        'Central Library story time is Saturday, Aug 8, and Riverdale Farm is Sunday, Aug 9.',
      ),
    ).toEqual([
      'Central Library story time is Saturday, Aug 8',
      'Riverdale Farm is Sunday, Aug 9.',
    ]);
  });
});

describe('borrowedFindDates', () => {
  it('allows Aug 8 and Aug 9 when each sits in its own find clause', () => {
    const reply =
      'Central Library story time is Saturday, Aug 8, and Riverdale Farm visit is Sunday, Aug 9.';
    expect(borrowedFindDates(reply, [STORY, FARM])).toEqual([]);
  });

  it('still flags a date borrowed onto the other find inside one clause', () => {
    const reply = 'Riverdale Farm is open Sunday Aug 8.';
    expect(borrowedFindDates(reply, [STORY, FARM]).length).toBeGreaterThan(0);
  });

  it('allows a find its own date', () => {
    expect(borrowedFindDates('Riverdale Farm is open Sunday Aug 9.', [STORY, FARM])).toEqual([]);
    expect(
      borrowedFindDates('Central Library story time is Sat, Aug 8.', [STORY, FARM]),
    ).toEqual([]);
  });
});
