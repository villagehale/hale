import { describe, expect, it } from 'vitest';
import { type Platform, channelOrder, platformFromUa, qrLeads } from './chooser.js';

/**
 * The channel matrix, pinned exhaustively: every platform × liveness cell from
 * the F14 chooser spec. The two laws under test — liveness gates (a dark channel
 * is absent, never disabled) and the UA hint orders-never-gates a live mobile
 * channel (the one withholding is `sms:` on non-Apple desktop, where the link is
 * dead and the QR is the path).
 */

const UAS: Record<Exclude<Platform, 'unknown'>, string> = {
  apple:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  'desktop-mac':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'desktop-other':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

describe('platformFromUa — a hint, parsed with fixed probes', () => {
  it.each(Object.entries(UAS) as [Platform, string][])('recognises %s', (platform, ua) => {
    expect(platformFromUa(ua)).toBe(platform);
  });

  it('treats an iPad as apple, not as the Mac its engine claims', () => {
    // Legacy iPad UAs carry "iPad"; the probe order must catch it before Macintosh.
    expect(
      platformFromUa('Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15'),
    ).toBe('apple');
  });

  it('maps a missing header to unknown and an unrecognised one to desktop-other', () => {
    expect(platformFromUa(null)).toBe('unknown');
    expect(platformFromUa('')).toBe('desktop-other');
    expect(platformFromUa('curl/8.6.0')).toBe('desktop-other');
    expect(platformFromUa('Mozilla/5.0 (X11; Linux x86_64) Firefox/127.0')).toBe('desktop-other');
  });
});

describe('channelOrder — the full matrix', () => {
  const BOTH = { sms: true, wa: true };
  const WA_DARK = { sms: true, wa: false };
  const SMS_DARK = { sms: false, wa: true };
  const NONE = { sms: false, wa: false };

  it('apple: Messages primary, WhatsApp secondary when live', () => {
    expect(channelOrder('apple', BOTH)).toEqual(['messages', 'whatsapp']);
    expect(channelOrder('apple', WA_DARK)).toEqual(['messages']);
  });

  it('android: WhatsApp primary when live, Messages still one tap away — the hint never gates it', () => {
    expect(channelOrder('android', BOTH)).toEqual(['whatsapp', 'messages']);
    // WhatsApp dark: Messages alone, primary — no dead WhatsApp button.
    expect(channelOrder('android', WA_DARK)).toEqual(['messages']);
  });

  it('desktop-mac: Messages.app really opens, so it leads; wa.me (WhatsApp Web) trails', () => {
    expect(channelOrder('desktop-mac', BOTH)).toEqual(['messages', 'whatsapp']);
    expect(channelOrder('desktop-mac', WA_DARK)).toEqual(['messages']);
  });

  it('desktop-other and unknown: never an sms: button — dead on Windows/Linux; WhatsApp iff live', () => {
    for (const platform of ['desktop-other', 'unknown'] as const) {
      expect(channelOrder(platform, BOTH)).toEqual(['whatsapp']);
      // WhatsApp dark too: no buttons at all — the QR card is the whole path.
      expect(channelOrder(platform, WA_DARK)).toEqual([]);
    }
  });

  it('a dark channel is absent on every platform — liveness gates, no disabled buttons', () => {
    for (const platform of [
      'apple',
      'android',
      'desktop-mac',
      'desktop-other',
      'unknown',
    ] as const) {
      expect(channelOrder(platform, NONE)).toEqual([]);
      expect(channelOrder(platform, SMS_DARK)).not.toContain('messages');
      expect(channelOrder(platform, WA_DARK)).not.toContain('whatsapp');
    }
  });
});

describe('qrLeads — the QR card is the hero exactly where buttons cannot carry the page', () => {
  it('leads on desktop-other and unknown, trails everywhere else', () => {
    expect(qrLeads('desktop-other')).toBe(true);
    expect(qrLeads('unknown')).toBe(true);
    expect(qrLeads('apple')).toBe(false);
    expect(qrLeads('android')).toBe(false);
    expect(qrLeads('desktop-mac')).toBe(false);
  });
});
