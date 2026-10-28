import { describe, expect, it } from 'vitest';
import { SHARED_GROUP_VOICE_SKILL, sharedGroupLineInput } from './shared-group-line-input';
import { sharedLineUsable } from './shared-group-voice';

describe('shared group line input', () => {
  it('gives the intro one question and the stop no question', () => {
    const intro = sharedGroupLineInput({ kind: 'intro', adderFirstName: 'Mei' }, 'en');
    expect(intro.questions).toBe(1);
    expect(intro.maxChars).toBe(240);
    expect(intro.facts.adderFirstName).toBe('Mei');
    const stop = sharedGroupLineInput({ kind: 'member_stop', name: 'Jordan' }, 'en');
    expect(stop.questions).toBe(0);
    expect(stop.wayOut).toBe(true);
  });

  it('refuses a private token, a URL, and a second question', () => {
    const answer = sharedGroupLineInput({ kind: 'answer', lookup: null }, 'en');
    expect(sharedLineUsable('Saturday at the pool the thread already named.', answer)).toBe(true);
    expect(sharedLineUsable('Zephyrina has soccer', answer, ['Zephyrina'])).toBe(false);
    expect(sharedLineUsable('See https://example.com', answer)).toBe(false);
    expect(sharedLineUsable('Are you in? What time?', answer)).toBe(false);
    expect(sharedLineUsable('TODO-Design: placeholder', answer)).toBe(false);
  });

  it('hands the model facts and a skill name, not a parent line', () => {
    const intro = sharedGroupLineInput({ kind: 'intro', adderFirstName: 'Mei' }, 'en');
    expect(intro.skill).toBe(SHARED_GROUP_VOICE_SKILL);
    expect(intro.facts).toEqual({ adderFirstName: 'Mei' });
    expect(intro).not.toHaveProperty('line');
  });
});
