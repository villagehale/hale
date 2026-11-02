import { describe, expect, it } from 'vitest';
import { OFFER_RECEIPT_FIXTURES } from './offer-receipt-fixtures.mjs';

describe('offer-receipt fixtures', () => {
  it('covers Hale’s calendar with no Google, Google connected, and a non-English parent', () => {
    const byId = new Map(OFFER_RECEIPT_FIXTURES.map((fixture) => [fixture.id, fixture.facts]));
    expect(byId.get('en-hale-no-google')).toMatchObject({
      happened: 'added',
      language: null,
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: false,
      alsoOnGoogle: false,
    });
    expect(byId.get('en-hale-google-connected')).toMatchObject({
      happened: 'added',
      language: null,
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: true,
      alsoOnGoogle: false,
    });
    const french = byId.get('fr-hale-no-google');
    expect(french).toMatchObject({
      happened: 'added',
      language: null,
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: false,
      alsoOnGoogle: false,
    });
    expect(french?.parentReply.startsWith('Oui')).toBe(true);
  });
});
