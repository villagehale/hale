import { describe, expect, it } from 'vitest';
import {
  healthFactsForRegion,
  healthRegionFromPlace,
  healthRegionFromTokens,
  medicalMustInclude,
  medicalTextHasRequiredNumbers,
  textHasNumber,
} from './health-resources';

describe('health facts for a region', () => {
  it('hands Ontario its line, and British Columbia its own', () => {
    const ontario = healthFactsForRegion('ON');
    const bc = healthFactsForRegion('BC');
    expect(ontario).toEqual({
      region: 'Ontario',
      healthLine: 'Health811 (Ontario), call 811, any time',
      emergency: '911',
    });
    expect(bc).toEqual({
      region: 'British Columbia',
      healthLine: 'HealthLink BC, call 8-1-1, any time',
      emergency: '911',
    });
    expect(ontario.healthLine).not.toContain('HealthLink');
    expect(bc.healthLine).not.toContain('Health811');
  });

  it('passes both health lines and 911 when the region is unknown', () => {
    const facts = healthFactsForRegion(null);
    expect(facts).toEqual(healthFactsForRegion(undefined));
    expect(facts.region).toBeNull();
    expect(facts.healthLine).toContain('Health811 (Ontario), call 811, any time');
    expect(facts.healthLine).toContain('HealthLink BC, call 8-1-1, any time');
    expect(facts.emergency).toBe('911');
    expect(`${facts.healthLine} ${facts.emergency}`).not.toMatch(/988|\b112\b|\b15\b/);
  });

  it('reads Ontario and BC from a province or a postal token, and does not guess', () => {
    expect(healthRegionFromTokens(['Ontario'])).toBe('ON');
    expect(healthRegionFromTokens(['BC'])).toBe('BC');
    expect(healthRegionFromTokens(['M5V 2T6'])).toBe('ON');
    expect(healthRegionFromTokens(['V6B 1A1'])).toBe('BC');
    expect(healthRegionFromTokens(['on the couch', 'Toronto', '90210', 'H2Y 1C6'])).toBeNull();
    expect(healthRegionFromTokens([null, undefined])).toBeNull();
    expect(healthRegionFromPlace({ provinceOrState: 'British Columbia' })).toBe('BC');
    expect(healthRegionFromPlace({ provinceOrState: 'California' })).toBeNull();
    expect(healthRegionFromPlace(null)).toBeNull();
  });
});

describe('medical number presence', () => {
  it('matches 811 and 911 with dashes or spaces, and not inside a longer number', () => {
    expect(textHasNumber('Call 8-1-1 or 9 1 1.', '811')).toBe(true);
    expect(textHasNumber('Call 8-1-1 or 9 1 1.', '911')).toBe(true);
    expect(textHasNumber('Call 811 or 911.', '911')).toBe(true);
    expect(textHasNumber('Ring 647-555-0811.', '811')).toBe(false);
    expect(textHasNumber('Swim at 9:11.', '911')).toBe(false);
    expect(textHasNumber('Call 811.', '911')).toBe(false);
  });

  it('requires 911 on an emergency, and both numbers on a health worry', () => {
    expect(medicalMustInclude('emergency')).toEqual(['911']);
    expect(medicalMustInclude('health')).toEqual(['811', '911']);
    expect(medicalTextHasRequiredNumbers('emergency', 'Call 9-1-1 now.')).toBe(true);
    expect(medicalTextHasRequiredNumbers('emergency', 'Call 8-1-1.')).toBe(false);
    expect(medicalTextHasRequiredNumbers('health', 'Call 8-1-1 or 9-1-1.')).toBe(true);
    expect(medicalTextHasRequiredNumbers('health', 'Call 911 now.')).toBe(false);
  });
});
