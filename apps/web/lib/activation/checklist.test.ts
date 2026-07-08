import { describe, expect, it } from 'vitest';
import { type ActivationSignals, allStepsDone, deriveActivationSteps } from './checklist.js';

const NONE: ActivationSignals = {
  acceptedCandidateCount: 0,
  hasUserCoachMessage: false,
  hasCoParent: false,
};

function stepDone(signals: ActivationSignals, id: ActivationStepId): boolean {
  const step = deriveActivationSteps(signals).find((s) => s.id === id);
  if (!step) throw new Error(`no step ${id}`);
  return step.done;
}

type ActivationStepId = ReturnType<typeof deriveActivationSteps>[number]['id'];

describe('deriveActivationSteps', () => {
  it('always returns the four core-loop steps in order, each with an href', () => {
    const steps = deriveActivationSteps(NONE);
    expect(steps.map((s) => s.id)).toEqual(['village', 'plan', 'coach', 'invite']);
    for (const step of steps) {
      expect(step.href).toMatch(/^\//);
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it('marks "add an activity" done only when the family has >=1 accepted candidate', () => {
    expect(stepDone({ ...NONE, acceptedCandidateCount: 0 }, 'plan')).toBe(false);
    expect(stepDone({ ...NONE, acceptedCandidateCount: 1 }, 'plan')).toBe(true);
    expect(stepDone({ ...NONE, acceptedCandidateCount: 3 }, 'plan')).toBe(true);
  });

  it('marks "ask Hale" done only when a user message exists in the thread', () => {
    expect(stepDone({ ...NONE, hasUserCoachMessage: false }, 'coach')).toBe(false);
    expect(stepDone({ ...NONE, hasUserCoachMessage: true }, 'coach')).toBe(true);
  });

  it('marks "invite a parent" done only when a co-parent has joined', () => {
    expect(stepDone({ ...NONE, hasCoParent: false }, 'invite')).toBe(false);
    expect(stepDone({ ...NONE, hasCoParent: true }, 'invite')).toBe(true);
  });

  it('treats "see your village" as done once any other step is done', () => {
    expect(stepDone(NONE, 'village')).toBe(false);
    expect(stepDone({ ...NONE, acceptedCandidateCount: 1 }, 'village')).toBe(true);
    expect(stepDone({ ...NONE, hasUserCoachMessage: true }, 'village')).toBe(true);
    expect(stepDone({ ...NONE, hasCoParent: true }, 'village')).toBe(true);
  });
});

describe('allStepsDone', () => {
  it('is false on a brand-new family and true only when every step is satisfied', () => {
    expect(allStepsDone(NONE)).toBe(false);
    expect(
      allStepsDone({ acceptedCandidateCount: 1, hasUserCoachMessage: true, hasCoParent: false }),
    ).toBe(false);
    expect(
      allStepsDone({ acceptedCandidateCount: 1, hasUserCoachMessage: true, hasCoParent: true }),
    ).toBe(true);
  });
});
