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
  };

  it('refuses an ack that gives no time, but not a stopped note, which may promise none', () => {
    const silent = { ...clear, says_when: 'no' as const };
    expect(ackMeaningProblems(silent, { latestMinutes: 5, requireTime: true })).toEqual([
      'no_time',
    ]);
    expect(ackMeaningProblems(silent, { latestMinutes: null, requireTime: false })).toEqual([]);
  });

  it('names every problem the verdict raises', () => {
    const bad: AckJudgeVerdict = {
      reason: 'all wrong',
      says_when: 'yes',
      breaks_window: 'yes',
      claims_done: 'yes',
      points_at_an_app: 'yes',
    };
    expect(ackMeaningProblems(bad, { latestMinutes: 5, requireTime: true })).toEqual([
      'time_outside_window',
      'claims_done',
      'points_at_the_app',
    ]);
  });
});
