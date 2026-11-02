import { describe, expect, it } from 'vitest';
import { crisisFactsForRegion } from './crisis-resources';

describe('crisis facts for a region', () => {
  it('hands Canada its own line, and the US its own', () => {
    const canada = crisisFactsForRegion('CA');
    const us = crisisFactsForRegion('US');
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
    expect(canada?.crisisLine).not.toBe(us?.crisisLine);
  });

  it('names no line when the region is unknown', () => {
    expect(crisisFactsForRegion(null)).toBeNull();
    expect(crisisFactsForRegion(undefined)).toBeNull();
  });

  it('carries 988 and 911, never a line for another country', () => {
    for (const region of ['CA', 'US'] as const) {
      const facts = crisisFactsForRegion(region);
      expect(facts?.emergency).toBe('911');
      expect(facts?.crisisLine).toContain('988');
      expect(`${facts?.crisisLine} ${facts?.emergency}`).not.toMatch(/3114|\b112\b|\b811\b|\b15\b/);
    }
  });
});
