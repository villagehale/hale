import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_ORDER,
  type OnboardingChecklist,
  THREAD_V2_ORDER,
  acceptOnboardingCapture,
  activitiesAnswered,
  checklistAfter,
  googleAnswered,
  mergeCaptures,
  newActivities,
  onboardingMissing,
  onboardingOrder,
  storedChecklist,
} from './onboarding-turn';
import type { IntakeSession } from './session';
import { THREAD_ONBOARDING_V2_ENABLED_ENV } from './thread-onboarding-v2';

/**
 * VIL-721 · the walk with THREAD_ONBOARDING_V2_ENABLED dark and lit. Dark, the order,
 * the capture and the checklists are the objects they were. Lit, the activities item
 * sits after the ages, one Google item replaces Gmail and the calendar, and the
 * capture keeps the activities the model read, shape-checked.
 */

function lit() {
  vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'true');
  // The in-thread walk rides the friend walk.
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
}

// Dark is pinned, not assumed: the flags-on CI job turns every default-off flag on.
beforeEach(() => {
  vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'false');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const BASE: OnboardingChecklist = {
  postal: true,
  kids: true,
  ages: true,
  name: false,
  gmail: false,
  calendar: false,
  schedule: false,
  coparent: false,
};

function session(given: Record<string, unknown> | null): IntakeSession {
  return {
    id: 'session-1',
    phoneHash: 'hash',
    phoneE164: '+15555550100',
    state: 'awaiting_cold_start',
    sourceCode: null,
    collected: {
      children: [{ name: 'Maya', ageMonths: 72, agePrecision: 'years' }],
      postalCode: null,
    },
    transcript: [],
    followUpCount: 0,
    clarifyCount: 0,
    familyId: 'family-1',
    userId: 'user-1',
    lastProviderId: null,
    findWon: false,
    ladderNext: null,
    ladderLanguage: null,
    linqContactCardClaim: null,
    firstTouch: {
      language: 'en',
      place: null,
      locationRequest: null,
      given: given as never,
    },
  } as IntakeSession;
}

describe('the order', () => {
  it('is today’s while dark and the in-thread walk while lit', () => {
    expect(onboardingOrder()).toEqual(ONBOARDING_ORDER);
    lit();
    expect(onboardingOrder()).toEqual(THREAD_V2_ORDER);
    expect(THREAD_V2_ORDER).toEqual([
      'postal',
      'kids',
      'ages',
      'activities',
      'name',
      'google',
      'schedule',
      'coparent',
    ]);
  });

  it('lit, asks the activities right after the ages, and counts a missing item as open', () => {
    lit();
    expect(onboardingMissing(BASE)).toEqual([
      'activities',
      'name',
      'google',
      'schedule',
      'coparent',
    ]);
    expect(onboardingMissing({ ...BASE, activities: true, name: true })).toEqual([
      'google',
      'schedule',
      'coparent',
    ]);
  });
});

describe('the capture', () => {
  const raw = {
    activities: [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }],
    activitiesNone: false,
    connectGoogle: true,
    googleLater: false,
  };

  it('is the object it was while dark: no VIL-721 key', () => {
    const capture = acceptOnboardingCapture(raw);
    for (const key of ['activities', 'activitiesNone', 'connectGoogle', 'googleLater']) {
      expect(capture).not.toHaveProperty(key);
    }
  });

  it('lit, keeps the activities the model read, shape-checked', () => {
    lit();
    const capture = acceptOnboardingCapture({
      activities: [
        { child: 'Maya', activity: '  swim    lessons ', when: ' Saturdays ' },
        { child: 'maya', activity: 'SWIM LESSONS' },
        { child: 'Leo 2', activity: 'soccer' },
        { child: null, activity: '42' },
        { activity: 'piano' },
        'not an object',
      ],
      connectGoogle: false,
      googleLater: true,
    });
    expect(capture.activities).toEqual([
      { child: 'Maya', activity: 'swim lessons', when: 'Saturdays' },
      { child: null, activity: 'soccer', when: null },
      { child: null, activity: 'piano', when: null },
    ]);
    expect(capture.connectGoogle).toBe(false);
    expect(capture.googleLater).toBe(true);
  });

  it('lit, keeps a long phrase whole: no character cap decides what the parent said', () => {
    lit();
    const long =
      'after-school Mandarin at the community centre with her cousin on Tuesdays and Thursdays until five';
    const capture = acceptOnboardingCapture({
      activities: [{ child: 'Maya', activity: long, when: long }],
    });
    expect(capture.activities).toEqual([{ child: 'Maya', activity: long, when: long }]);
  });

  it('lit, keeps a time written only in digits', () => {
    lit();
    const capture = acceptOnboardingCapture({
      activities: [{ child: 'Maya', activity: 'swim', when: ' 18:00 ' }],
    });
    expect(capture.activities).toEqual([{ child: 'Maya', activity: 'swim', when: '18:00' }]);
  });

  it("lit, keeps the model's health mark only when it is exactly true", () => {
    lit();
    const capture = acceptOnboardingCapture({
      activities: [
        { child: 'Maya', activity: 'speech therapy', when: null, health: true },
        { child: 'Maya', activity: 'ballet', when: null, health: false },
        { child: 'Leo', activity: 'soccer', when: null, health: 'true' },
      ],
    });
    expect(capture.activities).toEqual([
      { child: 'Maya', activity: 'speech therapy', when: null, health: true },
      { child: 'Maya', activity: 'ballet', when: null },
      { child: 'Leo', activity: 'soccer', when: null },
    ]);
  });

  it('lit, caps one message at twelve activities', () => {
    lit();
    const many = Array.from({ length: 15 }, (_, i) => ({ child: null, activity: `class ${i}` }));
    expect(acceptOnboardingCapture({ activities: many }).activities).toHaveLength(12);
  });

  it('lit, takes "none" only when nothing was kept', () => {
    lit();
    expect(acceptOnboardingCapture({ activitiesNone: true }).activitiesNone).toBe(true);
    expect(acceptOnboardingCapture({ ...raw, activitiesNone: true }).activitiesNone).toBe(false);
  });

  it('lit, merges a later message without repeating an activity', () => {
    lit();
    const first = acceptOnboardingCapture(raw);
    const second = acceptOnboardingCapture({
      activities: [
        { child: 'Maya', activity: 'Swim Lessons' },
        { child: 'Maya', activity: 'ballet' },
      ],
      connectGoogle: null,
    });
    const merged = mergeCaptures(first, second);
    expect(merged.activities?.map((item) => item.activity)).toEqual(['swim lessons', 'ballet']);
    expect(merged.connectGoogle).toBe(true);
  });
});

describe('the checklists', () => {
  it('carry no VIL-721 item while dark', () => {
    expect(checklistAfter(BASE, acceptOnboardingCapture({}))).not.toHaveProperty('activities');
    expect(storedChecklist(session(null), null, false)).not.toHaveProperty('google');
  });

  it('lit, answer the activities on a kept one or a none, and Google on any answer to the link', () => {
    lit();
    const after = checklistAfter(
      BASE,
      acceptOnboardingCapture({ activities: [{ activity: 'soccer' }], googleLater: true }),
    );
    expect(after).toMatchObject({ activities: true, google: true });
    expect(checklistAfter(BASE, acceptOnboardingCapture({}))).toMatchObject({
      activities: false,
      google: false,
    });
  });

  it('lit, a landed one-link connect answers Gmail, the calendar and the Google item', () => {
    lit();
    expect(storedChecklist(session(null), 'google', false)).toMatchObject({
      gmail: true,
      calendar: true,
      google: true,
    });
    expect(
      storedChecklist(
        session({
          parentName: null,
          activityPick: null,
          connectCalendar: null,
          connectGmail: null,
          activities: [{ child: 'Maya', activity: 'swim lessons', when: null }],
        }),
        null,
        false,
      ),
    ).toMatchObject({ activities: true, google: false });
  });
});

describe('the small readers', () => {
  it('newActivities keeps only what is new, by kid and phrase', () => {
    const kept = [{ child: 'Maya', activity: 'swim lessons', when: null }];
    expect(
      newActivities(kept, [
        { child: 'Maya', activity: 'Swim lessons', when: 'Sat' },
        { child: 'Leo', activity: 'swim lessons', when: null },
      ]),
    ).toEqual([{ child: 'Leo', activity: 'swim lessons', when: null }]);
  });

  it('activitiesAnswered and googleAnswered read what the session holds', () => {
    expect(activitiesAnswered(null)).toBe(false);
    expect(activitiesAnswered({ activitiesNone: true })).toBe(true);
    expect(activitiesAnswered({ activities: [{ child: null, activity: 'x', when: null }] })).toBe(
      true,
    );
    expect(googleAnswered({ connectGoogle: false })).toBe(true);
    expect(googleAnswered({ googleLater: true })).toBe(true);
    expect(googleAnswered({ connectGoogle: null })).toBe(false);
  });
});
