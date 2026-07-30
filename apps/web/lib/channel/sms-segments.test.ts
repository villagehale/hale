import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from './sms-segments.js';

/**
 * Expectations are derived from the GSM 03.38 / 3GPP TS 23.040 spec, not from the
 * implementation: a GSM-7 message fits 160 septets alone and 153 per part once it is
 * concatenated (the 6-byte UDH eats 7 septets); a message containing ANY character
 * outside GSM-7 is sent as UCS-2, where the budget collapses to 70 units alone and 67
 * per concatenated part. An extension character (`€`, `[`) costs TWO septets.
 */

describe('smsEncoding', () => {
  it('is gsm7 for plain ASCII copy', () => {
    expect(smsEncoding("Want me to keep an eye on all of this for you?")).toBe('gsm7');
  });

  it('is gsm7 for the accented + currency characters GSM-7 actually covers', () => {
    expect(smsEncoding('Café £5 à Montréal')).toBe('gsm7');
  });

  it('is ucs2 as soon as one character falls outside GSM-7 (an em dash, a curly quote)', () => {
    expect(smsEncoding('Hale — your week')).toBe('ucs2');
    expect(smsEncoding("Hale’s week")).toBe('ucs2');
  });
});

describe('smsSegments — GSM-7', () => {
  it('160 septets is one segment, 161 is two', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
  });

  it('counts 153 septets per part once concatenated (306 = 2, 307 = 3)', () => {
    expect(smsSegments('a'.repeat(306))).toBe(2);
    expect(smsSegments('a'.repeat(307))).toBe(3);
  });

  it('charges an extension character two septets', () => {
    // 80 euro signs = 160 septets — exactly one segment; 81 tips it over.
    expect(smsSegments('€'.repeat(80))).toBe(1);
    expect(smsSegments('€'.repeat(81))).toBe(2);
  });

  it('counts a newline as one septet (the radar joins its blocks with blank lines)', () => {
    expect(smsSegments(`${'a'.repeat(158)}\n\n`)).toBe(1);
    expect(smsSegments(`${'a'.repeat(159)}\n\n`)).toBe(2);
  });
});

describe('smsSegments — UCS-2', () => {
  it('70 units is one segment, 71 is two', () => {
    expect(smsSegments(`—${'a'.repeat(69)}`)).toBe(1);
    expect(smsSegments(`—${'a'.repeat(70)}`)).toBe(2);
  });

  it('counts 67 units per part once concatenated (134 = 2, 135 = 3)', () => {
    expect(smsSegments(`—${'a'.repeat(133)}`)).toBe(2);
    expect(smsSegments(`—${'a'.repeat(134)}`)).toBe(3);
  });

  it('counts an astral character as the two UTF-16 units the wire actually carries', () => {
    // 35 emoji = 70 UTF-16 units = one segment; 36 tips it over.
    expect(smsSegments('😀'.repeat(35))).toBe(1);
    expect(smsSegments('😀'.repeat(36))).toBe(2);
  });
});

describe('smsSegments — edges', () => {
  it('an empty body is one segment (a send is still a send)', () => {
    expect(smsSegments('')).toBe(1);
  });
});
