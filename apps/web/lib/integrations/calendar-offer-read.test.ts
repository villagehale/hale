import { describe, expect, it } from 'vitest';
import { toCoachOffer } from './calendar-offer-read';
import { receiptLineOk } from './offer-receipt';

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

describe('receiptLineOk', () => {
  const facts = {
    happened: 'added' as const,
    title: 'Gymnastics',
    when: 'Sunday, Oct 4 at 9:00 a.m.',
    parentReply: '好的',
  };

  it('accepts a line that carries both facts', () => {
    expect(receiptLineOk('Gymnastics is on your week, Sunday, Oct 4 at 9:00 a.m.', facts)).toBe(
      true,
    );
  });

  it('rejects a line that drops the rendered instant', () => {
    expect(receiptLineOk('Gymnastics is on your week.', facts)).toBe(false);
  });
});
