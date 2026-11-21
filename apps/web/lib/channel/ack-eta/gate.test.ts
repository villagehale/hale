import { describe, expect, it } from 'vitest';
import { mechanicalProblems } from './compose';
import { type AckJudgeVerdict, ackMeaningProblems } from './judge';

/**
 * VIL-717 · the pure halves of the gate: what code refuses on Hale's own line, and how a
 * judge verdict maps to problems for the window the line was written against. What the
 * model writes and how it judges is the cached eval's (rule #8).
 */

describe('mechanicalProblems', () => {
  it.each([
    ['', ['empty']],
    ['On it, back to you within five minutes.', []],
    ['On it. Want me to look wider?', ['asks_a_question']],
    ['我在查，五分钟内回复你？', ['asks_a_question']],
    ['On it, details at example.com soon.', ['carries_link']],
  ])('%j -> %j', (line, expected) => {
    expect(mechanicalProblems(line, 0)).toEqual(expected);
  });
});

describe('ackMeaningProblems', () => {
  const clear: AckJudgeVerdict = {
    reason: 'fine',
    says_when: 'yes',
    breaks_window: 'no',
    claims_done: 'no',
    points_at_an_app: 'no',
    promises_answer: 'no',
  };

  it('refuses an ack that gives no time, but not a stopped note, which may promise none', () => {
    const silent = { ...clear, says_when: 'no' as const };
    expect(
      ackMeaningProblems(silent, { latestMinutes: 5, requireTime: true, answerMayNotCome: false }),
    ).toEqual(['no_time']);
    expect(
      ackMeaningProblems(silent, {
        latestMinutes: null,
        requireTime: false,
        answerMayNotCome: false,
      }),
    ).toEqual([]);
  });

  it('refuses a still-working note that promises the answer, but not an ack that does', () => {
    const promised = { ...clear, promises_answer: 'yes' as const };
    expect(
      ackMeaningProblems(promised, {
        latestMinutes: 180,
        requireTime: true,
        answerMayNotCome: true,
      }),
    ).toEqual(['promises_the_answer']);
    expect(
      ackMeaningProblems(promised, {
        latestMinutes: 5,
        requireTime: true,
        answerMayNotCome: false,
      }),
    ).toEqual([]);
    expect(
      ackMeaningProblems(clear, { latestMinutes: 180, requireTime: true, answerMayNotCome: true }),
    ).toEqual([]);
  });

  it('names every problem the verdict raises', () => {
    const bad: AckJudgeVerdict = {
      reason: 'all wrong',
      says_when: 'yes',
      breaks_window: 'yes',
      claims_done: 'yes',
      points_at_an_app: 'yes',
      promises_answer: 'yes',
    };
    expect(
      ackMeaningProblems(bad, { latestMinutes: 5, requireTime: true, answerMayNotCome: true }),
    ).toEqual(['time_outside_window', 'claims_done', 'points_at_the_app', 'promises_the_answer']);
  });
});
