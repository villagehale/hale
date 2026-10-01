import { describe, expect, it } from 'vitest';
import {
  HALE_PUBLIC_SMS_DISPLAY,
  HALE_PUBLIC_SMS_E164,
  INTAKE_PREFILL,
  buildSmsBody,
  buildSmsHref,
  buildSmsHrefForBody,
  displaySmsNumber,
  parseSourceCode,
  readSmsNumber,
  smsUriFormForPlatform,
} from './text-entry.js';

/**
 * M5 entry surfaces — the pure half: what a QR card's `?s=` code is allowed to
 * be, what the parent's composer is pre-filled with, and when the SMS path is
 * live at all. Expected values come from the VIL-240 convention (documented in
 * text-entry.ts), not from what the implementation happens to emit.
 */

describe('parseSourceCode (venue attribution from ?s=)', () => {
  it('accepts the per-venue codes the print cards carry', () => {
    expect(parseSourceCode('earlyon-richmondhill')).toBe('earlyon-richmondhill');
    expect(parseSourceCode('swim-loyalfitness')).toBe('swim-loyalfitness');
    expect(parseSourceCode('daycare-brightpath-milton')).toBe('daycare-brightpath-milton');
    expect(parseSourceCode('qr1')).toBe('qr1');
  });

  /**
   * The two tags that are not venues at all and still ride this funnel: a per-family
   * referral (`friend-…`) and a co-parent join link (`join-…`). Neither is minted here
   * — the app writes them — so this is the cross-app control that the grammar has not
   * quietly narrowed under them. A `?s=` this page dropped would pre-write a greeting
   * with no tag in it, and the arrival would be a stranger starting a new household.
   */
  it('passes the app-minted tags through untouched', () => {
    expect(parseSourceCode('friend-0123456789ab')).toBe('friend-0123456789ab');
    expect(parseSourceCode('join-x7k2')).toBe('join-x7k2');
    expect(parseSourceCode('join-0123456789abcdef0123456789abcdef')).toBe(
      'join-0123456789abcdef0123456789abcdef',
    );
  });

  it('rejects anything that is not a lowercase kebab code — the token is pasted into an SMS body and an analytics property', () => {
    for (const bad of [
      undefined,
      '',
      '   ',
      'EarlyON-RichmondHill', // uppercase
      'earlyon richmondhill', // space
      'earlyon_richmondhill', // underscore
      '-earlyon',
      'earlyon-',
      'earlyon--hill',
      '<script>alert(1)</script>',
      'a@b.com',
      'earlyon)+18005551234(',
      'x'.repeat(49), // over the 48-char ceiling
    ]) {
      expect(parseSourceCode(bad), `${String(bad)} must not be accepted`).toBeNull();
    }
  });

  it('ignores a repeated param — Next hands back an array and there is only ever one source', () => {
    expect(parseSourceCode(['earlyon-richmondhill', 'swim-loyalfitness'])).toBeNull();
  });
});

const LOCKED_PREFILL = "Hey Hale, what's going on?";

/** The query body a composer href will hand the phone, percent-decoding included.
 * iOS has no `?` (`sms:<number>&body=`); Android and the cross form do. */
function hrefQueryBody(href: string, key: 'body' | 'text'): string {
  const query = href.includes('?')
    ? href.slice(href.indexOf('?') + 1).replace(/^&/, '')
    : href.slice(href.indexOf('&') + 1);
  const value = new URLSearchParams(query).get(key);
  if (value === null) throw new Error(`missing ${key} in ${href}`);
  return value;
}

describe('buildSmsBody (what the parent sends)', () => {
  it('is the locked warm hello when no venue sent them — a real first message, no dummy family', () => {
    expect(INTAKE_PREFILL).toBe(LOCKED_PREFILL);
    expect(buildSmsBody(null)).toBe(LOCKED_PREFILL);
    expect(INTAKE_PREFILL).not.toBe('What is worth doing with the kids near us?');
  });

  it('appends the venue as a trailing "(via …)" token', () => {
    expect(buildSmsBody('earlyon-richmondhill')).toBe(
      `${LOCKED_PREFILL} (via earlyon-richmondhill)`,
    );
  });
});

describe('buildSmsHref (the deep link)', () => {
  it('is an sms: URI whose body is percent-encoded, carrying the source token', () => {
    expect(buildSmsHref('+16475551234', 'earlyon-richmondhill')).toBe(
      'sms:+16475551234?&body=Hey%20Hale%2C%20what%27s%20going%20on%3F%20(via%20earlyon-richmondhill)',
    );
  });

  it('pre-fills the locked hello with no source', () => {
    expect(buildSmsHref('+16475551234', null)).toBe(
      'sms:+16475551234?&body=Hey%20Hale%2C%20what%27s%20going%20on%3F',
    );
  });

  it('percent-encodes the apostrophe so the decoded sms: body is the locked prefill', () => {
    const href = buildSmsHref('+16475551234', null);
    expect(href).toContain('%27');
    expect(href).not.toContain("'");
    expect(hrefQueryBody(href, 'body')).toBe(LOCKED_PREFILL);
    expect(hrefQueryBody(buildSmsHref('+16475551234', 'earlyon-richmondhill'), 'body')).toBe(
      `${LOCKED_PREFILL} (via earlyon-richmondhill)`,
    );
  });

  it('uses the form the opening phone reads, and every form decodes to the same body', () => {
    const ios = buildSmsHrefForBody('+16475551234', LOCKED_PREFILL, 'ios');
    const android = buildSmsHrefForBody('+16475551234', LOCKED_PREFILL, 'android');
    const cross = buildSmsHrefForBody('+16475551234', LOCKED_PREFILL, 'cross');
    expect(ios).toBe('sms:+16475551234&body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
    expect(android).toBe('sms:+16475551234?body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
    expect(cross).toBe('sms:+16475551234?&body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
    expect(ios).not.toContain('?');
    expect(android).not.toContain('?&');
    for (const href of [ios, android, cross]) {
      expect(hrefQueryBody(href, 'body')).toBe(LOCKED_PREFILL);
    }
    expect(smsUriFormForPlatform('apple')).toBe('ios');
    expect(smsUriFormForPlatform('desktop-mac')).toBe('ios');
    expect(smsUriFormForPlatform('android')).toBe('android');
    expect(smsUriFormForPlatform('desktop-other')).toBe('cross');
    expect(smsUriFormForPlatform('unknown')).toBe('cross');
  });
});

describe('readSmsNumber (NEXT_PUBLIC_HALE_SMS_NUMBER)', () => {
  it('is empty until the number is provisioned — undefined and blank both mean "not live"', () => {
    expect(readSmsNumber(undefined)).toBe('');
    expect(readSmsNumber('')).toBe('');
    expect(readSmsNumber('   ')).toBe('');
  });

  it('survives the trailing-newline env trap and internal spacing', () => {
    expect(readSmsNumber('+16475551234\n')).toBe('+16475551234');
    expect(readSmsNumber(' +1 647 555 1234 ')).toBe('+16475551234');
  });

  it('treats a non-E.164 value as not live rather than emitting a broken sms: link', () => {
    for (const bad of ['647-555-1234', '16475551234', 'coming-soon', '+1', '+0123456789']) {
      expect(readSmsNumber(bad), `${bad} must not be treated as a live number`).toBe('');
    }
  });
});

describe('displaySmsNumber (the number shown on the page)', () => {
  it('spaces a North American number into its readable grouping', () => {
    expect(displaySmsNumber('+16475551234')).toBe('(647) 555-1234');
  });

  it('renders the public Linq line as (646) 235-2164', () => {
    expect(HALE_PUBLIC_SMS_E164).toBe('+16462352164');
    expect(HALE_PUBLIC_SMS_DISPLAY).toBe('(646) 235-2164');
    expect(displaySmsNumber(HALE_PUBLIC_SMS_E164)).toBe(HALE_PUBLIC_SMS_DISPLAY);
  });

  it('shows any other country code as-is rather than mangling it', () => {
    expect(displaySmsNumber('+442071234567')).toBe('+442071234567');
  });
});
