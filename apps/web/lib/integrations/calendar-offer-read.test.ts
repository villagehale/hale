import { describe, expect, it } from 'vitest';
import { toCoachOffer } from './calendar-offer-read';
import {
  OFFER_RECEIPT_ADDRESS,
  type OfferReceiptFacts,
  offerReceiptUserMessage,
} from './offer-receipt';

describe('toCoachOffer', () => {
  it('keeps a past instant for the recorder to refuse', () => {
    const startsAt = new Date('2026-10-01T20:15:00.000Z');
    expect(
      toCoachOffer({
        offer: true,
        title: 'Gymnastics',
        startsAt: startsAt.toISOString(),
        location: '',
      }),
    ).toEqual({ status: 'offer', title: 'Gymnastics', startsAt, location: null });
  });

  it('returns none when the sentence is not an offer', () => {
    expect(
      toCoachOffer({
        offer: false,
        title: 'Gymnastics',
        startsAt: '2026-10-04T13:00:00.000Z',
        location: '',
      }),
    ).toEqual({ status: 'none', reason: 'no_offer' });
  });

  it('returns unreadable when the instant does not parse', () => {
    expect(
      toCoachOffer({ offer: true, title: 'Gymnastics', startsAt: 'Thursday', location: 'the gym' }),
    ).toEqual({ status: 'none', reason: 'unreadable' });
  });
});

describe('offerReceiptUserMessage', () => {
  const facts: OfferReceiptFacts = {
    happened: 'added',
    title: 'Gymnastics',
    when: 'Sunday, Oct 4 at 9:00 a.m.',
    parentReply: 'Oui, ça me va',
    language: 'en',
    googleCalendarConnected: false,
    placedOn: 'hale_family_calendar',
    alsoOnGoogle: false,
  };

  it('hands the model the save facts, tu address, and the parent’s own words', () => {
    expect(JSON.parse(offerReceiptUserMessage(facts))).toEqual({
      happened: 'added',
      title: 'Gymnastics',
      when: 'Sunday, Oct 4 at 9:00 a.m.',
      parentWords: 'Oui, ça me va',
      language: 'en',
      address: OFFER_RECEIPT_ADDRESS,
      googleCalendarConnected: false,
      placedOn: 'hale_family_calendar',
      alsoOnGoogle: false,
    });
    expect(OFFER_RECEIPT_ADDRESS).toBe('tu');
  });
});
