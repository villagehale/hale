import { describe, expect, it } from 'vitest';
import {
  acceptOnboardingCapture,
  checklistAfter,
  confirmActivityPick,
  onboardingMissing,
  storedFromCapture,
} from './onboarding-turn';

const prior = {
  children: [],
  postalCode: null,
  place: null,
  parentName: null,
  activityPick: null,
  connectCalendar: null,
  connectGmail: null,
};

describe('onboarding capture', () => {
  it('keeps a postal field and drops a sentence', () => {
    const clean = acceptOnboardingCapture({ postalCode: 'M5V 2T6' });
    expect(storedFromCapture(prior, clean).place?.postalCode).toBe('M5V 2T6');
    const sentence = acceptOnboardingCapture({ postalCode: 'we are in M5V 2T6' });
    expect(storedFromCapture(prior, sentence).place).toBeNull();
  });

  it('keeps a pending pick until the real lines exist, then only a real index', () => {
    expect(acceptOnboardingCapture({ activityPick: 1 }, { findLineCount: 0 }).activityPick).toBe(1);
    expect(acceptOnboardingCapture({ activityPick: 4 }, { findLineCount: 0 }).activityPick).toBeNull();
    expect(confirmActivityPick(1, 2)).toBe(1);
    expect(confirmActivityPick(3, 2)).toBeNull();
    expect(confirmActivityPick(1, 0)).toBeNull();
  });

  it('skips every stored item and leaves the first gap', () => {
    const capture = acceptOnboardingCapture({
      postalCode: 'M5V',
      children: [{ name: 'Maya', ageMonths: 48, agePrecision: 'years' }],
      parentName: 'Dana',
    });
    const after = checklistAfter(
      {
        postal: false,
        ages: false,
        pick: false,
        name: false,
        calendar: false,
        gmail: false,
      },
      capture,
      { pickConfirmed: true },
    );
    expect(onboardingMissing(after)).toEqual(['calendar', 'gmail']);
    expect(storedFromCapture(prior, capture).collectedChildren[0]?.name).toBe('Maya');
  });
});
