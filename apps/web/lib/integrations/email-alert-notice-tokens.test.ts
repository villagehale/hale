import { describe, expect, it } from 'vitest';
import { stripEmailOnlyNoticeTokens } from './email-alert-notice-tokens';

/**
 * VIL-628 on the notice path: when the writer saw the email body, phones, codes and
 * hosts the facts do not carry are cut. Names are not. A facts-only draft is not this
 * module's job.
 */

const FACTS = JSON.stringify({
  email: { title: 'Saturday swim cancelled', sender: 'Riverside Pool' },
  offer: 'add_to_week',
});

describe('stripEmailOnlyNoticeTokens', () => {
  it('drops a host, phone and code the facts do not carry', () => {
    const text =
      'Saturday swim is off. Call 416-555-0199 or visit rsvp.example and use code AB12-XY.';
    expect(stripEmailOnlyNoticeTokens(text, FACTS)).toBe(
      'Saturday swim is off. Call or visit and use code.',
    );
  });

  it('keeps a host the facts already name', () => {
    const trusted = JSON.stringify({ email: { title: 'Meet at kidsclub.ca' } });
    expect(stripEmailOnlyNoticeTokens('Meet at kidsclub.ca this Saturday.', trusted)).toBe(
      'Meet at kidsclub.ca this Saturday.',
    );
  });

  it('a leftover scheme still has link shape and is cut as a host', () => {
    expect(
      stripEmailOnlyNoticeTokens('Saturday swim is off. See https://evil.example/x', FACTS),
    ).toBe('Saturday swim is off. See');
  });

  it('does not cut names', () => {
    expect(stripEmailOnlyNoticeTokens('Robin’s Saturday swim is off.', FACTS)).toBe(
      'Robin’s Saturday swim is off.',
    );
  });
});
