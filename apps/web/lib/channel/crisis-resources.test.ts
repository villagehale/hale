import { describe, expect, it } from 'vitest';
import { crisisFactsForRegion } from './crisis-resources';

describe('crisis facts for a region', () => {
  it('hands a mental-health signal Canada its own line, and the US its own', () => {
    const canada = crisisFactsForRegion('CA', 'mental');
    const us = crisisFactsForRegion('US', 'mental');
    expect(canada).toEqual({
      region: 'Canada',
      crisisLine: '9-8-8 Suicide Crisis Helpline: call or text 988, any time, in English or French',
      emergency: '911',
    });
    expect(us).toEqual({
      region: 'United States',
      crisisLine: '988 Suicide & Crisis Lifeline: call or text 988, any time',
      emergency: '911',
    });
    expect(canada.crisisLine).not.toBe(us.crisisLine);
  });

  it('passes both 988 lines and 911 when a mental-health signal has no region', () => {
    const facts = crisisFactsForRegion(null, 'mental');
    expect(facts).toEqual(crisisFactsForRegion(undefined, 'mental'));
    expect(facts).toEqual({
      region: null,
      canadaCrisisLine:
        '9-8-8 Suicide Crisis Helpline: call or text 988, any time, in English or French',
      usCrisisLine: '988 Suicide & Crisis Lifeline: call or text 988, any time',
      emergency: '911',
    });
    expect(facts.canadaCrisisLine).toContain('988');
    expect(facts.usCrisisLine).toContain('988');
    expect(`${facts.canadaCrisisLine} ${facts.usCrisisLine} ${facts.emergency}`).not.toMatch(
      /3114|\b112\b|\b811\b|\b15\b/,
    );
  });

  it('gives a physical emergency 911 only, in every region', () => {
    for (const region of ['CA', 'US', null, undefined] as const) {
      const facts = crisisFactsForRegion(region, 'emergency');
      expect(facts).toEqual({ emergency: '911' });
      expect(JSON.stringify(facts)).not.toContain('988');
      expect(JSON.stringify(facts)).not.toContain('9-8-8');
    }
  });
});
