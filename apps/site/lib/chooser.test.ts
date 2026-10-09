import { describe, expect, it } from 'vitest';
import {
  MESSAGES_NO_FLASH_SCRIPT,
  type Platform,
  channelOrder,
  messagesCapable,
  platformFromUa,
  qrLeads,
} from './chooser.js';

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

describe('channelOrder — SMS when the link works, otherwise the QR', () => {
  const LIVE = { sms: true };
  const DARK = { sms: false };

  it('offers Messages on the platforms where sms: opens a composer', () => {
    expect(channelOrder('apple', LIVE)).toEqual(['messages']);
    expect(channelOrder('android', LIVE)).toEqual(['messages']);
    expect(channelOrder('desktop-mac', LIVE)).toEqual(['messages']);
  });

  it('offers no button on desktop-other and unknown — the QR is the path', () => {
    expect(channelOrder('desktop-other', LIVE)).toEqual([]);
    expect(channelOrder('unknown', LIVE)).toEqual([]);
  });

  it('offers nothing when the number is dark', () => {
    for (const platform of [
      'apple',
      'android',
      'desktop-mac',
      'desktop-other',
      'unknown',
    ] as const) {
      expect(channelOrder(platform, DARK)).toEqual([]);
    }
  });
});

describe('messagesCapable — sms: only where a composer actually opens', () => {
  it('is true for iPhone, iPad, Mac, and Android, and false otherwise', () => {
    expect(messagesCapable('apple')).toBe(true);
    expect(messagesCapable('android')).toBe(true);
    expect(messagesCapable('desktop-mac')).toBe(true);
    expect(messagesCapable('desktop-other')).toBe(false);
    expect(messagesCapable('unknown')).toBe(false);
  });

  it('agrees with the pre-paint script for every probe, including an empty UA', () => {
    const samples = [
      ...Object.values(UAS),
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15',
      '',
      'curl/8.6.0',
      'Mozilla/5.0 (X11; Linux x86_64) Firefox/127.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    ];
    for (const ua of samples) {
      const scriptYes = /iPhone|iPad|Android|Macintosh/.test(ua);
      expect(scriptYes, ua).toBe(messagesCapable(platformFromUa(ua)));
    }
    expect(MESSAGES_NO_FLASH_SCRIPT).toContain('data-hale-messages');
    expect(MESSAGES_NO_FLASH_SCRIPT).toContain('iPhone|iPad|Android|Macintosh');
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
