import { describe, expect, it } from 'vitest';
import { guardActivityPick } from './pick-evidence';

const query = { town: 'Burlington, Ontario, Canada', window: 'October 2026', asOf: '2026-10-13' };
const page =
  'Burlington, Ontario, Canada. Preschool Storytime for ages 3-6. October 20, 2026 at 10:30am. Admission £5 per child.';
const row = {
  name: 'Preschool Storytime',
  age_fit: 'ages 3-6',
  source_name: 'Burlington Library',
  source_url: 'https://library.example/event',
  location_quote: 'Burlington, Ontario, Canada',
  relevance: 'current',
  relevance_quote: 'October 20, 2026 at 10:30am',
  when: 'October 20, 2026 at 10:30am',
  when_quote: 'October 20, 2026 at 10:30am',
  price: '£5 per child',
  price_quote: 'Admission £5 per child',
  event_date: '2026-10-20',
};
const pages = [{ url: row.source_url, text: page }];

describe('fresh activity field evidence (deterministic guards, not a model quality eval)', () => {
  it('keeps locally published future facts', () => {
    expect(guardActivityPick(row, pages, query)).toMatchObject({
      price: '£5 per child',
      event_date: '2026-10-20',
    });
  });
  it('rejects the real Burlington WA / completed 2024 source for Ontario', () => {
    const text =
      'Preschool Storytime. Burlington, WA 98233 United States. For ages 3-6. Wednesday, October 9, 2024 10:30am–11:30am. Please note you are looking at an event that has already happened.';
    expect(
      guardActivityPick(
        {
          ...row,
          location_quote: 'Burlington, WA 98233 United States',
          relevance_quote: 'Wednesday, October 9, 2024 10:30am–11:30am',
        },
        [{ url: row.source_url, text }],
        query,
      ),
    ).toBeNull();
  });
  it.each(['past', 'wrong_location', 'outside_window'])(
    'refuses extraction classified as %s',
    (relevance) => {
      expect(guardActivityPick({ ...row, relevance }, pages, query)).toBeNull();
    },
  );
  it('does not infer free or accept a real unrelated quote as price evidence', () => {
    expect(
      guardActivityPick({ ...row, price: 'Free', price_quote: row.when_quote }, pages, query)
        ?.price,
    ).toBeNull();
  });
  it('does not let the single-page hourly reader invent a registration opening', () => {
    expect(
      guardActivityPick({ ...row, registration: 'Registration opens October 18' }, pages, query)
        ?.registration,
    ).toBeNull();
  });
  it('does not carry a fabricated event date beside a genuine quote', () => {
    expect(
      guardActivityPick({ ...row, event_date: '2026-10-21' }, pages, query)?.event_date,
    ).toBeNull();
  });
  it('rejects an expired event even if the model says current', () => {
    expect(
      guardActivityPick(
        {
          ...row,
          event_date: '2024-10-09',
          when: 'October 9, 2024',
          when_quote: 'October 9, 2024',
          relevance_quote: 'October 9, 2024',
        },
        [{ url: row.source_url, text: `${page} October 9, 2024` }],
        query,
      ),
    ).toBeNull();
  });
  it('keeps an undated program with honest missing schedule, not a fabricated recurrence', () => {
    const unknown = {
      ...row,
      relevance: 'unknown',
      relevance_quote: null,
      when: 'Every Wednesday',
      when_quote: null,
      event_date: null,
    };
    expect(guardActivityPick(unknown, pages, query)).toMatchObject({
      when: null,
      event_date: null,
    });
  });
  it('fails closed on unquoted age, wrong URL and missing location proof', () => {
    for (const bad of [
      { ...row, age_fit: 'ages 9-12' },
      { ...row, source_url: 'https://elsewhere.example' },
      { ...row, location_quote: '' },
    ]) {
      expect(guardActivityPick(bad, pages, query)).toBeNull();
    }
  });
});
