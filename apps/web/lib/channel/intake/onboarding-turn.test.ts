import { describe, expect, it } from 'vitest';
import {
  acceptOnboardingCapture,
  agesAreComplete,
  checklistAfter,
  coldStartIsStale,
  coldStartQuestionIsStale,
  confirmActivityPick,
  kidsAreNamed,
  mergeChildFacts,
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
    expect(
      acceptOnboardingCapture({ activityPick: 4 }, { findLineCount: 0 }).activityPick,
    ).toBeNull();
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
        kids: false,
        calendar: false,
        gmail: false,
      },
      capture,
      { pickConfirmed: true },
    );
    expect(onboardingMissing(after)).toEqual(['calendar', 'gmail']);
    expect(storedFromCapture(prior, capture).collectedChildren[0]?.name).toBe('Maya');
  });

  it('keeps a child who has a name and no age', () => {
    const capture = acceptOnboardingCapture({
      children: [
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
        { name: 'Leo', ageMonths: null, agePrecision: null },
      ],
    });
    expect(capture.children).toHaveLength(2);
    expect(agesAreComplete(capture.children)).toBe(false);
    expect(kidsAreNamed(capture.children)).toBe(true);
    const stored = storedFromCapture(prior, capture);
    expect(stored.collectedChildren[1]).toMatchObject({ name: 'Leo', ageMonths: null });
  });

  it('updates the only child when the model returns a corrected age', () => {
    const merged = mergeChildFacts(
      [{ name: 'Maya', ageMonths: 48, agePrecision: 'years' }],
      [{ name: null, ageMonths: 60, agePrecision: 'years' }],
    );
    expect(merged).toEqual([{ name: 'Maya', ageMonths: 60, agePrecision: 'years' }]);
  });

  it('treats a no and a later as answers so the ask is not repeated', () => {
    const capture = acceptOnboardingCapture({
      nameDeclined: true,
      calendarLater: true,
      connectGmail: false,
    });
    const after = checklistAfter(
      {
        postal: true,
        ages: true,
        pick: true,
        name: false,
        kids: true,
        calendar: false,
        gmail: false,
      },
      capture,
    );
    expect(onboardingMissing(after)).toEqual([]);
    expect(after.name).toBe(true);
    expect(after.calendar).toBe(true);
    expect(after.gmail).toBe(true);
  });

  it('calls a cold-start thread stale after six hours and not before', () => {
    const now = new Date('2026-10-04T18:00:00.000Z');
    expect(coldStartIsStale(new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(), now)).toBe(
      true,
    );
    expect(coldStartIsStale(new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(), now)).toBe(
      false,
    );
    expect(coldStartIsStale(null, now)).toBe(false);
  });

  it('retires only a stale find, and keeps a next-day name or calendar answer', () => {
    const now = new Date('2026-10-04T18:00:00.000Z');
    const old = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString();
    expect(coldStartQuestionIsStale('pick', old, now)).toBe(true);
    expect(coldStartQuestionIsStale('names', old, now)).toBe(false);
    expect(coldStartQuestionIsStale('follow', old, now)).toBe(false);
    expect(coldStartQuestionIsStale('logistics', old, now)).toBe(false);
    expect(coldStartQuestionIsStale('pick', now.toISOString(), now)).toBe(false);
  });
});
