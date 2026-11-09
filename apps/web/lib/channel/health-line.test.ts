import { describe, expect, it } from 'vitest';
import { type HealthPlace, healthLineFacts, healthNumbersIn } from './health-line';

// D1 (VIL-589): 911 everywhere Hale serves; a regional number only where an official
// source names it. Today that is Ontario's Health811 alone. Everyone else is told
// their child's doctor's after-hours line, which carries no number.
const DOCTOR_LINE = "your child's doctor's after-hours line";
const ONTARIO_LINE = 'Health811 (Ontario), call 811, any time';
const N11_811 = /\b811\b/;

const PLACES: ReadonlyArray<HealthPlace | null> = [
  null,
  { country: 'US', provinceOrState: 'Washington' },
  { country: 'CA', provinceOrState: null },
  { country: 'CA', provinceOrState: 'Quebec' },
  { country: 'CA', provinceOrState: 'Ontario' },
];

describe('healthLineFacts', () => {
  it('a US family gets 911 and their doctor, and never 811 (the US dig line)', () => {
    const us = healthLineFacts({ country: 'US', provinceOrState: 'Washington' });
    expect(us).toStrictEqual({
      basis: 'united_states',
      facts: { healthLine: DOCTOR_LINE, emergency: '911' },
      mustInclude: ['911'],
    });
    expect(JSON.stringify(us)).not.toMatch(N11_811);
    // Positive control: the same check does see 811 where it belongs.
    expect(JSON.stringify(healthLineFacts({ country: 'CA', provinceOrState: 'Ontario' }))).toMatch(
      N11_811,
    );
  });

  it('an unknown region gets 911 and their doctor', () => {
    expect(healthLineFacts(null)).toStrictEqual({
      basis: 'region_unknown',
      facts: { healthLine: DOCTOR_LINE, emergency: '911' },
      mustInclude: ['911'],
    });
  });

  it('a province with no verified row, or no province, gets 911 and their doctor', () => {
    expect(healthLineFacts({ country: 'CA', provinceOrState: 'Quebec' })).toStrictEqual({
      basis: 'province_unverified',
      facts: { healthLine: DOCTOR_LINE, emergency: '911' },
      mustInclude: ['911'],
    });
    expect(healthLineFacts({ country: 'CA', provinceOrState: null })).toStrictEqual({
      basis: 'canada_province_unknown',
      facts: { healthLine: DOCTOR_LINE, emergency: '911' },
      mustInclude: ['911'],
    });
  });

  it('Ontario keeps exactly the line production sends today', () => {
    const ontario = healthLineFacts({ country: 'CA', provinceOrState: 'Ontario' });
    expect(ontario).toStrictEqual({
      basis: 'ontario',
      facts: { healthLine: ONTARIO_LINE, emergency: '911' },
      mustInclude: ['811', '911'],
    });
    // Key order is part of the said-line cache key and of the model's input.
    expect(Object.keys(ontario.facts)).toEqual(['healthLine', 'emergency']);
  });

  it('every required number is a number the facts state, and 911 is always last', () => {
    for (const place of PLACES) {
      const { facts, mustInclude } = healthLineFacts(place);
      const stated = Object.values(facts);
      for (const number of mustInclude) {
        expect(stated.some((value) => value.includes(number))).toBe(true);
      }
      expect(mustInclude.at(-1)).toBe(facts.emergency);
    }
  });

  it('a row is chosen only by the postal table spelling, never from free text', () => {
    expect(healthLineFacts({ country: 'CA', provinceOrState: 'ontario ' }).basis).toBe(
      'province_unverified',
    );
    expect(healthLineFacts({ country: 'CA', provinceOrState: 'ON' }).basis).toBe(
      'province_unverified',
    );
    // A US place never reads a Canadian row, whatever its state is called.
    expect(healthLineFacts({ country: 'US', provinceOrState: 'Ontario' }).basis).toBe(
      'united_states',
    );
  });
});

describe('healthNumbersIn', () => {
  it('reads a three-digit health or emergency line however it is spaced', () => {
    expect(healthNumbersIn('Call 811 any time, or 911 now.')).toEqual(['811', '911']);
    expect(healthNumbersIn('HealthLink BC at 8-1-1, or 9 1 1 in an emergency')).toEqual([
      '811',
      '911',
    ]);
    expect(healthNumbersIn('立即拨打911')).toEqual(['911']);
  });

  it('does not read a number out of a phone number, a time, or a longer run', () => {
    expect(healthNumbersIn('647-555-0811, 555-811-0199, swim at 9:11, room 1911')).toEqual([]);
    // Positive control: the same text with the line on its own is read.
    expect(healthNumbersIn('647-555-0199, or call 811')).toEqual(['811']);
  });
});
