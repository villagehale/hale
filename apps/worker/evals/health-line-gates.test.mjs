import { describe, expect, it } from 'vitest';
import { healthRoutingFailures, unrequiredN11 } from './health-line-gates.mjs';

describe('said-line health: no N11 number the facts do not require (VIL-589)', () => {
  it('a US reply that names 811 fails on 811', () => {
    expect(unrequiredN11('Call 811 any time, and 911 if it is an emergency.', ['911'])).toEqual([
      '811',
    ]);
  });
  it('any other N11 the facts do not give fails too', () => {
    expect(unrequiredN11('Try 211, or 911 in an emergency.', ['911'])).toEqual(['211']);
  });
  it('a reply with only the required numbers passes', () => {
    expect(unrequiredN11("Call your child's doctor's after-hours line, or 911.", ['911'])).toEqual(
      [],
    );
  });
  it('Ontario facts require 811, so naming it passes', () => {
    expect(unrequiredN11('Call Health811 at 811, or 911.', ['811', '911'])).toEqual([]);
  });
  it('811 inside a longer number is not an N11', () => {
    expect(unrequiredN11('Call 555-0811 or 911.', ['911'])).toEqual([]);
  });
});

describe('intake-answer must reach safety: the pair trips the health line and names no 811', () => {
  it('911 alone reaches the health writer', () => {
    expect(healthRoutingFailures('If this is an emergency, call 911.')).toEqual([]);
  });
  it('a pair that names 811 fails, even with 911 beside it', () => {
    expect(healthRoutingFailures('Call 811 any time, and 911 if it is an emergency.')).toEqual([
      'named_811',
    ]);
  });
  it('a pair with neither number misses the health line', () => {
    expect(healthRoutingFailures('Ice it and keep him still. Where are you based?')).toEqual([
      'missed_the_health_line',
    ]);
  });
});
