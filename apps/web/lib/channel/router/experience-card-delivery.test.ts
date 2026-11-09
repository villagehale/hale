import { describe, expect, it } from 'vitest';
import { experienceCardDelivery } from './route';

const CARD = { url: 'https://example.org/swim', title: 'Sat swim 10am' };
const IM = {
  channel: 'imessage' as const,
  to: '+14375550101',
  chatId: 'chat-1',
  replyToMessageId: null,
};

describe('experienceCardDelivery (VIL-497)', () => {
  it('iMessage 1:1: the card carries the page, so the URL leaves the text', () => {
    expect(experienceCardDelivery('Swim has room. https://example.org/swim', CARD, IM)).toEqual({
      text: 'Swim has room.',
      url: CARD.url,
      title: CARD.title,
      chatId: 'chat-1',
      to: IM.to,
    });
  });

  it('no card on SMS, on a group (null route), or with no card', () => {
    expect(
      experienceCardDelivery('x https://example.org/swim', CARD, { channel: 'sms', to: IM.to }),
    ).toBeNull();
    expect(experienceCardDelivery('x', CARD, null)).toBeNull();
    expect(experienceCardDelivery('x', null, IM)).toBeNull();
  });

  it('a reply that is only the URL keeps it and sends no card', () => {
    expect(experienceCardDelivery('https://example.org/swim', CARD, IM)).toBeNull();
  });
});
