import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from '~/lib/channel/router/open-questions';
import { decideIntentGate } from './decide';
import { toParentIntent } from './resolve';
import type { ParentIntentReading } from './types';

function question(over: Partial<OpenQuestion> = {}): OpenQuestion {
  return {
    id: 'q-plan',
    kind: 'plan_offer',
    description: 'Want the full plan?',
    subject: 'the full plan',
    answerable: { yes: true, no: false },
    askedAt: new Date('2026-10-01T00:00:00Z'),
    solicited: true,
    ...over,
  };
}

function reading(over: Partial<ParentIntentReading>): ParentIntentReading {
  return {
    intent: 'other',
    confidence: 'low',
    targetId: null,
    index: null,
    value: null,
    ...over,
  };
}

describe('decideIntentGate', () => {
  const pending = [question()];

  it('sure go ahead affirms the pending offer', () => {
    const decision = decideIntentGate(
      reading({ intent: 'affirm', confidence: 'high', targetId: 'q-plan' }),
      pending,
    );
    expect(decision).toMatchObject({ action: 'resolved', polarity: 'yes', questionId: 'q-plan' });
  });

  it('nah declines, and a plan offer has nowhere to put a no', () => {
    const decision = decideIntentGate(
      reading({ intent: 'decline', confidence: 'high', targetId: 'q-plan' }),
      pending,
    );
    expect(decision).toEqual({ action: 'coach', reason: 'not_answerable' });
  });

  it('less often pls is a weekly cadence', () => {
    const decision = decideIntentGate(
      reading({ intent: 'cadence', confidence: 'medium', value: 'weekly' }),
      [],
    );
    expect(decision.action).toBe('directed');
  });

  it('oui and 好的 are affirmations when the reading says so', () => {
    for (const phrase of ['oui', '好的']) {
      const raw = toParentIntent({
        intent: 'affirm',
        confidence: 'high',
        targetId: 'q-plan',
        value: phrase,
      });
      expect(decideIntentGate(raw, pending)).toMatchObject({ action: 'resolved', polarity: 'yes' });
    }
  });

  it('what? stays with the coach', () => {
    const decision = decideIntentGate(reading({ intent: 'unclear', confidence: 'low' }), pending);
    expect(decision).toEqual({ action: 'coach', reason: 'unclear' });
  });

  it('does not guess an irreversible act', () => {
    expect(decideIntentGate(reading({ intent: 'undo', confidence: 'medium' }), pending)).toEqual({
      action: 'coach',
      reason: 'below_grade',
    });
    expect(decideIntentGate(reading({ intent: 'signup', confidence: 'medium' }), pending)).toEqual({
      action: 'coach',
      reason: 'below_grade',
    });
    expect(
      decideIntentGate(reading({ intent: 'cadence', confidence: 'medium', value: 'off' }), []),
    ).toEqual({ action: 'coach', reason: 'below_grade' });
  });
});
