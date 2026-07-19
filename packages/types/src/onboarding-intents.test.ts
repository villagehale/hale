import { describe, expect, it } from 'vitest';
import { ONBOARDING_INTENTS, isOnboardingIntent, parseIntents } from './index.js';

describe('isOnboardingIntent', () => {
  it('accepts known intents and rejects anything else', () => {
    expect(isOnboardingIntent('childcare')).toBe(true);
    expect(isOnboardingIntent('exploring')).toBe(true);
    expect(isOnboardingIntent('groceries')).toBe(false);
    expect(isOnboardingIntent('')).toBe(false);
  });

  it('accepts the baby-care intents with their prototype labels', () => {
    // Derived from the prototype handoff, not from ONBOARDING_INTENTS itself, so a
    // dropped value or a renamed label fails here.
    const expected: Record<string, string> = {
      sleep: 'Sleep & naps',
      feeding: 'Feeding & meals',
      potty: 'Potty training',
    };
    for (const [value, label] of Object.entries(expected)) {
      expect(isOnboardingIntent(value)).toBe(true);
      expect(ONBOARDING_INTENTS.find((i) => i.value === value)?.label).toBe(label);
    }
  });
});

describe('parseIntents', () => {
  it('drops unknown values, keeping only known intents', () => {
    expect(parseIntents(['activities', 'groceries', 'health'])).toEqual(['activities', 'health']);
  });

  it('de-duplicates repeated values', () => {
    expect(parseIntents(['sitter', 'sitter', 'sitter'])).toEqual(['sitter']);
  });

  it('normalizes to the canonical ONBOARDING_INTENTS order regardless of input order', () => {
    // 'exploring' is last, 'activities' is first — input reverses them.
    expect(parseIntents(['exploring', 'activities'])).toEqual(['activities', 'exploring']);
  });

  it('returns an empty array for no input (intents are optional)', () => {
    expect(parseIntents([])).toEqual([]);
  });

  it('round-trips every defined intent in declared order', () => {
    const all = ONBOARDING_INTENTS.map((i) => i.value);
    expect(parseIntents([...all].reverse())).toEqual(all);
  });
});
