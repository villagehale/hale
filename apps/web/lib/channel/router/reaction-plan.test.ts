import { describe, expect, it } from 'vitest';
import { type ReactionPlan, planParentReaction } from './reaction-plan';

const LOVE = { type: 'love' } as const;

function plan(overrides: Partial<Parameters<typeof planParentReaction>[0]> = {}): ReactionPlan {
  return planParentReaction({
    choice: { reaction: LOVE, alone: true, otherToolCalls: 0 },
    voiceMemo: false,
    attempts: 1,
    mints: 0,
    unplacedAnswer: false,
    bubbles: ['Anytime!'],
    ...overrides,
  });
}

describe('planParentReaction', () => {
  it('positive control: a clean closer stands alone for the words it replaces', () => {
    expect(plan()).toEqual({ kind: 'alone', reaction: LOVE, standsFor: 'Anytime!' });
  });

  it('keeps the words when the model did not ask for the reaction alone', () => {
    expect(plan({ choice: { reaction: LOVE, alone: false, otherToolCalls: 0 } })).toEqual({
      kind: 'beside',
      reaction: LOVE,
      why: 'not_asked',
    });
  });

  it.each([
    [
      'a tool ran this turn',
      { choice: { reaction: LOVE, alone: true, otherToolCalls: 1 } },
      'tools_ran',
    ],
    ['the reply owes a registration watch row', { mints: 1 }, 'owes_rows'],
    [
      'the turn exists to ask which question was answered',
      { unplacedAnswer: true },
      'unplaced_answer',
    ],
  ] as const)('never stands alone when %s: the words go beside it', (_label, overrides, why) => {
    expect(plan(overrides)).toEqual({ kind: 'beside', reaction: LOVE, why });
  });

  it.each([
    ['the model chose none', { choice: null }, 'not_chosen'],
    ['the claim gate asked the coach again', { attempts: 2 }, 'reasked'],
    ['the answer goes as several bubbles', { bubbles: ['One.', 'Two.'] }, 'several_bubbles'],
    ['the reply goes as a voice memo', { voiceMemo: true }, 'voice_memo'],
  ] as const)('reacts not at all when %s', (_label, overrides, reason) => {
    expect(plan(overrides)).toEqual({ kind: 'none', reason });
  });

  it('a custom emoji rides the plan unchanged', () => {
    const party = { type: 'custom', emoji: '🎉' } as const;
    expect(plan({ choice: { reaction: party, alone: false, otherToolCalls: 0 } })).toEqual({
      kind: 'beside',
      reaction: party,
      why: 'not_asked',
    });
  });
});
