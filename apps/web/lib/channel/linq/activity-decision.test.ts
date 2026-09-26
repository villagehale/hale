import { describe, expect, it } from 'vitest';
import { readGroupActivityDecision } from './activity-decision';

describe('readGroupActivityDecision', () => {
  it('reads a complete pick and a pass', () => {
    expect(readGroupActivityDecision('picked swim for Maya, Tuesday at 4:00')).toEqual({
      decision: 'picked',
      activity: 'swim',
      kid: 'Maya',
      day: 'Tuesday',
      time: '4:00',
    });
    expect(readGroupActivityDecision("We'll take swim for Maya Tuesday at 4")).toEqual({
      decision: 'picked',
      activity: 'swim',
      kid: 'Maya',
      day: 'Tuesday',
      time: '4',
    });
    expect(
      readGroupActivityDecision("we'll take art class for Maya, Wednesday at 4:00 pm."),
    ).toEqual({
      decision: 'picked',
      activity: 'art class',
      kid: 'Maya',
      day: 'Wednesday',
      time: '4:00 pm',
    });
    expect(readGroupActivityDecision('passed on art for Maya')).toEqual({
      decision: 'passed',
      activity: 'art',
      kid: 'Maya',
    });
    expect(readGroupActivityDecision('pass on art for Maya.')).toEqual({
      decision: 'passed',
      activity: 'art',
      kid: 'Maya',
    });
    expect(readGroupActivityDecision('choisi natation pour Maya, mardi a 16 h')).toEqual({
      decision: 'picked',
      activity: 'natation',
      kid: 'Maya',
      day: 'mardi',
      time: '16 h',
    });
    expect(readGroupActivityDecision('passe sur art pour Maya')).toEqual({
      decision: 'passed',
      activity: 'art',
      kid: 'Maya',
    });
  });

  it('skips a question, an email, a registration outcome, and an incomplete slot', () => {
    expect(readGroupActivityDecision('picked swim for Maya, Tuesday at 4:00?')).toBeNull();
    expect(readGroupActivityDecision('picked swim for maya@camp, Tuesday at 4')).toBeNull();
    expect(readGroupActivityDecision('we got in to swim for Maya, Tuesday at 4:00')).toBeNull();
    expect(readGroupActivityDecision('waitlisted swim for Maya')).toBeNull();
    expect(readGroupActivityDecision('missed art for Maya')).toBeNull();
    expect(readGroupActivityDecision('picked swim for Maya')).toBeNull();
    expect(readGroupActivityDecision('passed on art for Maya Tuesday at 4')).toBeNull();
    expect(readGroupActivityDecision('what should we do for Maya?')).toBeNull();
    expect(readGroupActivityDecision('')).toBeNull();
  });
});
