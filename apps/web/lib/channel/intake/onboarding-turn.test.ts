import { describe, expect, it } from 'vitest';
import {
  EMPTY_CHECKLIST,
  ONBOARDING_ORDER,
  acceptOnboardingCapture,
  acceptScheduleAdd,
  activityFromFindLine,
  agesAreComplete,
  checklistAfter,
  coldStartIsStale,
  coldStartQuestionIsStale,
  countRejectedScheduleAdds,
  kidsAreNamed,
  mergeCaptures,
  mergeChildFacts,
  onboardingMissing,
  storedFromCapture,
} from './onboarding-turn';

const prior = {
  children: [],
  postalCode: null,
  place: null,
  parentName: null,
  parentRole: null,
  connectCalendar: null,
  connectGmail: null,
};

describe('the onboarding order', () => {
  it('is postal, kids, ages, name, Gmail, calendar, schedule, co-parent — with no pick gate', () => {
    expect([...ONBOARDING_ORDER]).toEqual([
      'postal',
      'kids',
      'ages',
      'name',
      'gmail',
      'calendar',
      'schedule',
      'coparent',
    ]);
    expect(Object.keys(EMPTY_CHECKLIST).sort()).toEqual([...ONBOARDING_ORDER].sort());
  });
});

describe('onboarding capture', () => {
  it('keeps a postal field and drops a sentence', () => {
    const clean = acceptOnboardingCapture({ postalCode: 'M5V 2T6' });
    expect(storedFromCapture(prior, clean).place?.postalCode).toBe('M5V 2T6');
    const sentence = acceptOnboardingCapture({ postalCode: 'we are in M5V 2T6' });
    expect(storedFromCapture(prior, sentence).place).toBeNull();
  });

  it('takes the parent name and the kids names from one message', () => {
    const capture = acceptOnboardingCapture({
      parentName: 'Dana',
      children: [
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
        { name: 'Leo', ageMonths: null, agePrecision: null },
      ],
    });
    const stored = storedFromCapture(prior, capture);
    expect(stored.parentName).toBe('Dana');
    expect(stored.collectedChildren.map((child) => child.name)).toEqual(['Maya', 'Leo']);
    const after = checklistAfter({ ...EMPTY_CHECKLIST, postal: true }, capture);
    expect(after.name).toBe(true);
    expect(after.kids).toBe(true);
    expect(after.ages).toBe(false);
  });

  it('keeps a baby named before the parent, and fills the parent in later', () => {
    const first = acceptOnboardingCapture({
      children: [{ name: 'Leo', ageMonths: 14, agePrecision: 'months' }],
    });
    const stored = storedFromCapture(prior, first);
    expect(stored.collectedChildren).toEqual([
      { name: 'Leo', ageMonths: 14, agePrecision: 'months' },
    ]);
    expect(stored.parentName).toBeNull();
    const later = storedFromCapture(
      { ...prior, children: stored.collectedChildren },
      acceptOnboardingCapture({ parentName: 'Sam' }),
    );
    expect(later.parentName).toBe('Sam');
    expect(later.collectedChildren[0]?.name).toBe('Leo');
  });

  it('skips every stored item and leaves the first gap', () => {
    const capture = acceptOnboardingCapture({
      postalCode: 'M5V',
      children: [{ name: 'Maya', ageMonths: 48, agePrecision: 'years' }],
      parentName: 'Dana',
    });
    const after = checklistAfter(EMPTY_CHECKLIST, capture);
    expect(onboardingMissing(after)).toEqual(['gmail', 'calendar', 'schedule', 'coparent']);
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
      scheduleDone: true,
      coparentGroup: false,
    });
    const after = checklistAfter(
      { ...EMPTY_CHECKLIST, postal: true, ages: true, kids: true },
      capture,
    );
    expect(onboardingMissing(after)).toEqual([]);
    expect(after.name).toBe(true);
    expect(after.calendar).toBe(true);
    expect(after.gmail).toBe(true);
    expect(after.schedule).toBe(true);
    expect(after.coparent).toBe(true);
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

  it('retires only a legacy stale pick; every current item is answered the next day too', () => {
    const now = new Date('2026-10-04T18:00:00.000Z');
    const old = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString();
    expect(coldStartQuestionIsStale('pick', old, now)).toBe(true);
    for (const item of ONBOARDING_ORDER) {
      expect(coldStartQuestionIsStale(item, old, now)).toBe(false);
    }
    expect(coldStartQuestionIsStale('pick', now.toISOString(), now)).toBe(false);
  });
});

describe('the parent-role soft guess (VIL-417)', () => {
  it('stores a guess the model offered, marked as a guess', () => {
    const capture = acceptOnboardingCapture({
      parentName: 'Dana',
      parentRole: 'mother',
      parentRoleBasis: 'guessed',
    });
    expect(storedFromCapture(prior, capture).parentRole).toEqual({
      role: 'mother',
      basis: 'guessed',
    });
  });

  it('stays unknown for a unisex name, and unknown is stored as unknown', () => {
    const capture = acceptOnboardingCapture({
      parentName: 'Sam',
      parentRole: 'unknown',
      parentRoleBasis: 'guessed',
    });
    expect(storedFromCapture(prior, capture).parentRole).toEqual({
      role: 'unknown',
      basis: 'guessed',
    });
  });

  it('lets an explicit statement override an earlier guess, and never the reverse', () => {
    const guessed = storedFromCapture(
      prior,
      acceptOnboardingCapture({
        parentName: 'Sam',
        parentRole: 'mother',
        parentRoleBasis: 'guessed',
      }),
    );
    const stated = storedFromCapture(
      { ...prior, parentRole: guessed.parentRole },
      acceptOnboardingCapture({ parentRole: 'father', parentRoleBasis: 'stated' }),
    );
    expect(stated.parentRole).toEqual({ role: 'father', basis: 'stated' });

    const laterGuess = storedFromCapture(
      { ...prior, parentRole: stated.parentRole },
      acceptOnboardingCapture({ parentRole: 'mother', parentRoleBasis: 'guessed' }),
    );
    expect(laterGuess.parentRole).toEqual({ role: 'father', basis: 'stated' });
  });

  it('validates the enum: an unknown role is not stored, and an unknown basis is a guess', () => {
    expect(acceptOnboardingCapture({ parentRole: 'parent' }).parentRole).toBeNull();
    expect(acceptOnboardingCapture({ parentRole: 42 }).parentRole).toBeNull();
    // A basis the enum does not know can never promote a reading to "stated".
    expect(
      acceptOnboardingCapture({ parentRole: 'mother', parentRoleBasis: 'sure' }).parentRole,
    ).toEqual({ role: 'mother', basis: 'guessed' });
  });

  it('merges across turns the same way', () => {
    const first = acceptOnboardingCapture({ parentRole: 'mother', parentRoleBasis: 'guessed' });
    const second = acceptOnboardingCapture({ parentRole: 'father', parentRoleBasis: 'stated' });
    expect(mergeCaptures(first, second).parentRole).toEqual({ role: 'father', basis: 'stated' });
    const third = acceptOnboardingCapture({ parentRole: 'mother', parentRoleBasis: 'guessed' });
    expect(mergeCaptures(mergeCaptures(first, second), third).parentRole).toEqual({
      role: 'father',
      basis: 'stated',
    });
  });
});

describe('schedule adds (step 9)', () => {
  const limits = { findLineCount: 3, today: '2026-10-05' };

  it('keeps an add that points at a real line on a real future day', () => {
    expect(
      acceptScheduleAdd(
        { line: 2, cadence: 'weekly', date: '2026-10-10', time: '10:00', weeks: 6 },
        limits,
      ),
    ).toEqual({
      line: 2,
      child: null,
      cadence: 'weekly',
      date: '2026-10-10',
      time: '10:00',
      weeks: 6,
    });
  });

  it('drops a line Hale never showed, a past day, a bad time, and an unsettled date', () => {
    expect(acceptScheduleAdd({ line: 4, cadence: 'once', date: '2026-10-10' }, limits)).toBeNull();
    expect(acceptScheduleAdd({ line: 1, cadence: 'once', date: '2026-10-01' }, limits)).toBeNull();
    expect(acceptScheduleAdd({ line: 1, cadence: 'once' }, limits)).toBeNull();
    expect(acceptScheduleAdd({ line: 1, cadence: 'once', date: 'Saturday' }, limits)).toBeNull();
    expect(
      acceptScheduleAdd({ line: 1, cadence: 'once', date: '2026-10-10', time: '25:00' }, limits),
    ).toMatchObject({ time: null });
    expect(
      acceptScheduleAdd({ line: 1, cadence: 'weekly', date: '2026-10-10', weeks: 40 }, limits),
    ).toMatchObject({ weeks: null });
  });

  it('is capped at how far ahead it can write', () => {
    expect(acceptScheduleAdd({ line: 1, cadence: 'once', date: '2027-10-10' }, limits)).toBeNull();
  });

  it('dedupes the same add across turns', () => {
    const a = acceptOnboardingCapture(
      { scheduleAdds: [{ line: 1, cadence: 'once', date: '2026-10-10' }] },
      limits,
    );
    const b = acceptOnboardingCapture(
      {
        scheduleAdds: [
          { line: 1, cadence: 'once', date: '2026-10-10' },
          { line: 3, cadence: 'weekly', date: '2026-10-11' },
        ],
      },
      limits,
    );
    expect(mergeCaptures(a, b).scheduleAdds.map((add) => add.line)).toEqual([1, 3]);
  });

  it('keeps one add per line when the model settles the same activity eight times in one message', () => {
    const capture = acceptOnboardingCapture(
      {
        scheduleAdds: Array.from({ length: 8 }, (_, week) => ({
          line: 2,
          cadence: 'weekly',
          date: `2026-10-${String(10 + week).padStart(2, '0')}`,
          time: '10:00',
        })),
      },
      limits,
    );
    expect(capture.scheduleAdds).toEqual([
      { line: 2, child: null, cadence: 'weekly', date: '2026-10-10', time: '10:00', weeks: null },
    ]);
    expect(countRejectedScheduleAdds({ scheduleAdds: capture.scheduleAdds }, limits)).toBe(0);
  });

  it('counts the adds code refused so the reply that confirmed them is not sent', () => {
    const raw = {
      scheduleAdds: [
        { line: 1, cadence: 'once', date: '2026-10-10' },
        { line: 9, cadence: 'once', date: '2026-10-10' },
        { line: 2, cadence: 'weekly' },
      ],
    };
    expect(countRejectedScheduleAdds(raw, limits)).toBe(2);
    expect(countRejectedScheduleAdds(null, limits)).toBe(0);
    expect(countRejectedScheduleAdds({ reply: 'hi' }, limits)).toBe(0);
  });

  it('reads the title and day off a line Hale fetched', () => {
    expect(activityFromFindLine('Swim (ages 3-5) - Saturdays 10am')).toEqual({
      activity: 'Swim',
      day: 'Saturdays 10am',
    });
    expect(activityFromFindLine('EarlyON drop-in')).toEqual({
      activity: 'EarlyON drop-in',
      day: null,
    });
  });
});
