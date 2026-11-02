import { describe, expect, it, vi } from 'vitest';
import { toCoachOffer } from './calendar-offer-read';
import { createOfferReceiptWriter, offerReceiptUserMessage, receiptLineOk } from './offer-receipt';

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
    language: null,
    googleCalendarConnected: false,
    placedOn: 'hale_family_calendar' as const,
    alsoOnGoogle: false,
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

describe('offer receipt facts', () => {
  const facts = {
    happened: 'added' as const,
    title: 'Gymnastics',
    when: 'Sunday, Oct 4 at 9:00 a.m.',
    parentReply: 'yes',
    language: null,
    googleCalendarConnected: false,
    placedOn: 'hale_family_calendar' as const,
    alsoOnGoogle: false,
  };

  it('hands the model the connection and the place, and no sentence of its own', () => {
    const message = JSON.parse(offerReceiptUserMessage(facts)) as {
      parentWords: string;
      language: string | null;
      address: string;
      googleCalendarConnected: boolean;
      placedOn: string;
      alsoOnGoogle: boolean;
    };
    expect(message.parentWords).toBe('yes');
    expect(message.language).toBeNull();
    expect(message.address).toBe('tu');
    expect(message.googleCalendarConnected).toBe(false);
    expect(message.placedOn).toBe('hale_family_calendar');
    expect(message.alsoOnGoogle).toBe(false);
    const declined = JSON.parse(
      offerReceiptUserMessage({ ...facts, happened: 'declined', placedOn: null }),
    ) as { placedOn: null; googleCalendarConnected: boolean };
    expect(declined.placedOn).toBeNull();
    expect(declined.googleCalendarConnected).toBe(false);
  });

  it('sends nothing when the model cannot be reached', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const writer = createOfferReceiptWriter(() => {
      throw new Error('down');
    });
    await expect(writer.write(facts)).resolves.toBeNull();
    vi.unstubAllEnvs();
  });
});
