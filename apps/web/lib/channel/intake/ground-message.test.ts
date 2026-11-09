import { describe, expect, it } from 'vitest';
import { groundUserMessage } from './ground-message';

describe('groundUserMessage', () => {
  it('tells the search the country and the province or state, and nothing finer', () => {
    expect(
      JSON.parse(
        groundUserMessage('therapist for postpartum anxiety', {
          countryName: 'United States',
          provinceOrState: 'Washington',
        }),
      ),
    ).toEqual({
      question: 'therapist for postpartum anxiety',
      place: { country: 'United States', province_or_state: 'Washington' },
    });
  });

  it('leaves the province or state out when the table has none', () => {
    expect(
      JSON.parse(
        groundUserMessage('nap schedule', { countryName: 'Canada', provinceOrState: null }),
      ),
    ).toEqual({ question: 'nap schedule', place: { country: 'Canada' } });
  });

  it('sends no place when the session holds no Canadian or US code', () => {
    expect(JSON.parse(groundUserMessage('nap schedule', null))).toEqual({
      question: 'nap schedule',
    });
  });
});
