import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleEveningCheckInReply } from './reply';
import {
  createEveningRequestReader,
  eveningReplyIsRequest,
  toEveningRequestReading,
} from './request';

describe('toEveningRequestReading', () => {
  it('keeps a boolean and drops anything else', () => {
    expect(toEveningRequestReading({ asks: true })).toEqual({ asks: true });
    expect(toEveningRequestReading({ asks: false })).toEqual({ asks: false });
    expect(toEveningRequestReading({ asks: 'true' })).toBeNull();
    expect(toEveningRequestReading({})).toBeNull();
  });
});

describe('eveningReplyIsRequest', () => {
  it('hands a failed read to the coach', () => {
    expect(eveningReplyIsRequest(null)).toBe(true);
    expect(eveningReplyIsRequest({ asks: true })).toBe(true);
    expect(eveningReplyIsRequest({ asks: false })).toBe(false);
  });
});

describe('an injected reader decides, in any script', () => {
  const cases = [
    ['帮我找周六的游泳课', true],
    ['ساعدني أجد درس سباحة يوم السبت', true],
    ['Park after daycare and both asleep by 7.', false],
  ] as const;

  it.each(cases)('reads %s as asks=%s', async (text, asks) => {
    const reader = { read: async (_input: { text: string }) => ({ asks }) };
    expect(eveningReplyIsRequest(await reader.read({ text }))).toBe(asks);
  });
});

describe('createEveningRequestReader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a missing client and does not log the parent text', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const reader = createEveningRequestReader(() => {
      throw new Error('no key');
    });
    const text = '帮我找周六的游泳课';
    await expect(reader.read({ text })).resolves.toBeNull();
    expect(JSON.stringify(logged.mock.calls)).toContain('client_unavailable');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(text);
  });
});

describe('handleEveningCheckInReply with an injected reader', () => {
  it('is covered by the pglite file for the store, and a missing reader declines', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const outcome = await handleEveningCheckInReply({} as never, {
      familyId: 'f',
      parentUserId: 'p',
      body: '帮我找周六的游泳课',
      askedAt: new Date(),
      timeZone: 'America/Toronto',
      inboundChannelMessageId: 'm',
      now: new Date(),
    });
    expect(outcome).toEqual({ status: 'declined_to_claim' });
    expect(JSON.stringify(logged.mock.calls)).toContain('not_configured');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('游泳');
    logged.mockRestore();
  });
});
