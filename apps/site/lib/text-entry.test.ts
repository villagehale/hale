import { describe, expect, it } from 'vitest';
import {
  buildSmsBody,
  buildSmsHref,
  displaySmsNumber,
  parseSourceCode,
  readSmsNumber,
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

describe('buildSmsBody (what the parent sends)', () => {
  it('is the Designer-locked intake sample when no venue sent them', () => {
    // Designer lock 2026-08-27 chips/prefill — first SMS looks like intake, not a question.
    expect(buildSmsBody(null)).toBe('Maya is 4, Theo is 18 months, L3R');
  });

  it('appends the venue as a trailing "(via …)" token', () => {
    expect(buildSmsBody('earlyon-richmondhill')).toBe(
      'Maya is 4, Theo is 18 months, L3R (via earlyon-richmondhill)',
    );
  });
});

describe('buildSmsHref (the deep link)', () => {
  it('is an sms: URI whose body is percent-encoded, carrying the source token', () => {
    expect(buildSmsHref('+16475551234', 'earlyon-richmondhill')).toBe(
      'sms:+16475551234?&body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R%20(via%20earlyon-richmondhill)',
    );
  });

  it('pre-fills the locked intake sample with no source', () => {
    expect(buildSmsHref('+16475551234', null)).toBe(
      'sms:+16475551234?&body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R',
    );
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
    expect(displaySmsNumber('+16475551234')).toBe('+1 (647) 555-1234');
  });

  it('shows any other country code as-is rather than mangling it', () => {
    expect(displaySmsNumber('+442071234567')).toBe('+442071234567');
  });
});
