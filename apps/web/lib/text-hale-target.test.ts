import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PORTAL_INTAKE_PREFILL,
  messagesCapable,
  parsePortalSourceCode,
  platformFromUa,
  selectTextHaleHref,
  textPageHref,
} from './text-hale-target';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const NUMBER = '+16475551234';

describe('platformFromUa and messagesCapable', () => {
  it('treats iPhone, iPad, and Mac as Apple, and Android as Android', () => {
    expect(platformFromUa(IPHONE)).toBe('apple');
    expect(platformFromUa(IPAD)).toBe('apple');
    expect(platformFromUa(MAC)).toBe('desktop-mac');
    expect(platformFromUa(ANDROID)).toBe('android');
    expect(platformFromUa(WINDOWS)).toBe('desktop-other');
    expect(platformFromUa(null)).toBe('unknown');
    expect(platformFromUa('')).toBe('desktop-other');
  });

  it('opens a composer on Apple devices and Android only', () => {
    for (const platform of ['apple', 'android', 'desktop-mac'] as const) {
      expect(messagesCapable(platform)).toBe(true);
    }
    expect(messagesCapable('desktop-other')).toBe(false);
    expect(messagesCapable('unknown')).toBe(false);
  });
});

describe('parsePortalSourceCode', () => {
  it('keeps a referral and a join code, and drops an odd one', () => {
    expect(parsePortalSourceCode('ab12')).toBe('ab12');
    expect(parsePortalSourceCode('friend-0123456789ab')).toBe('friend-0123456789ab');
    expect(parsePortalSourceCode('join-abc123')).toBe('join-abc123');
    expect(parsePortalSourceCode('JOIN-ABC')).toBeNull();
    expect(parsePortalSourceCode('join-')).toBeNull();
    expect(parsePortalSourceCode(['ab12', 'friend-0123456789ab'])).toBeNull();
    expect(parsePortalSourceCode(undefined)).toBeNull();
  });
});

describe('selectTextHaleHref', () => {
  it('paints /text for an unknown client, carrying ?s= when there is one', () => {
    expect(
      selectTextHaleHref({
        platform: 'unknown',
        smsNumber: NUMBER,
        prefill: PORTAL_INTAKE_PREFILL,
        source: 'ab12',
      }),
    ).toEqual({ href: textPageHref('ab12'), composer: false });
    expect(textPageHref('ab12')).toBe('https://www.villagehale.com/text?s=ab12');
    expect(textPageHref(null)).toBe('https://www.villagehale.com/text');
  });

  it('opens Apple Messages with &body= and the (via <code>) suffix', () => {
    for (const platform of ['apple', 'desktop-mac'] as const) {
      const target = selectTextHaleHref({
        platform,
        smsNumber: NUMBER,
        prefill: PORTAL_INTAKE_PREFILL,
        source: 'friend-0123456789ab',
      });
      expect(target.composer).toBe(true);
      expect(target.href).toBe(
        `sms:${NUMBER}&body=Hey%20Hale%2C%20what%27s%20going%20on%3F%20(via%20friend-0123456789ab)`,
      );
      expect(target.href).not.toContain('?');
    }
  });

  it('opens Android with ?body=', () => {
    const target = selectTextHaleHref({
      platform: 'android',
      smsNumber: NUMBER,
      prefill: PORTAL_INTAKE_PREFILL,
      source: null,
    });
    expect(target.href).toBe(`sms:${NUMBER}?body=Hey%20Hale%2C%20what%27s%20going%20on%3F`);
  });

  it('leaves Windows on /text', () => {
    expect(
      selectTextHaleHref({
        platform: 'desktop-other',
        smsNumber: NUMBER,
        prefill: PORTAL_INTAKE_PREFILL,
        source: 'ab12',
      }).href,
    ).toBe('https://www.villagehale.com/text?s=ab12');
  });

  it('keeps the portal home thread link body-less when the device can open it', () => {
    expect(
      selectTextHaleHref({
        platform: 'apple',
        smsNumber: NUMBER,
        prefill: null,
        source: null,
      }).href,
    ).toBe(`sms:${NUMBER}`);
  });

  it('does not emit a broken sms: link when the number is empty', () => {
    const target = selectTextHaleHref({
      platform: 'apple',
      smsNumber: '',
      prefill: PORTAL_INTAKE_PREFILL,
      source: null,
    });
    expect(target.href).toBe('https://www.villagehale.com/text');
    expect(target.composer).toBe(false);
  });

  it('uses the same English hello the marketing site locks', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../site/lib/text-entry.ts', import.meta.url)),
      'utf8',
    );
    const prefill = /export const INTAKE_PREFILL = (["'])(.*?)\1;/.exec(src)?.[2];
    expect(prefill).toBe(PORTAL_INTAKE_PREFILL);
  });
});
