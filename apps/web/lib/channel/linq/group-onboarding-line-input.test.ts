import { describe, expect, it } from 'vitest';
import { groupOnboardingLineInput } from './group-onboarding-line-input';

/**
 * An ask does not hand the parent a list of words to reply with. Hale and a known
 * parent's name are facts the line must carry. STOP is a fact only where the line
 * is the way out.
 */

const ROLE_MENU = ['mom', 'dad', 'grandparent', 'nanny', 'babysitter', 'not family'];

describe('group onboarding line facts', () => {
  it('asks who someone is without listing role words to reply with', () => {
    for (const kind of ['roster_ask', 'member_ask', 'role_reask'] as const) {
      const input =
        kind === 'roster_ask'
          ? groupOnboardingLineInput({ kind, knownParentName: 'Riley', rosterSize: 3 }, 'en')
          : kind === 'member_ask'
            ? groupOnboardingLineInput({ kind, knownParentName: 'Riley' }, 'en')
            : groupOnboardingLineInput({ kind }, 'en');
      expect(input.questions).toBe(1);
      for (const word of ROLE_MENU) {
        expect(input.mustMention).not.toContain(word);
      }
    }
  });

  it('names Hale in the ask to a newly added member, not in the re-ask', () => {
    for (const language of ['en', 'fr'] as const) {
      const ask = groupOnboardingLineInput(
        { kind: 'member_ask', knownParentName: 'Riley' },
        language,
      );
      expect(ask.mustMention).toEqual(['Hale', 'Riley']);
      expect(groupOnboardingLineInput({ kind: 'role_reask' }, language).mustMention).not.toContain(
        'Hale',
      );
    }
  });

  it('carries STOP only on the 1:1 link line, which is the way out', () => {
    const connect = groupOnboardingLineInput(
      {
        kind: 'connect_link_1to1',
        name: null,
        knownParentName: 'Riley',
        providers: ['Google Calendar', 'Gmail'],
      },
      'en',
    );
    expect(connect).toMatchObject({ address: 'tu', linkFollows: true, wayOut: true });
    expect(connect.mustMention).toEqual(expect.arrayContaining(['Hale', 'Riley', 'STOP']));

    const textMe = groupOnboardingLineInput({ kind: 'text_me_directly', name: 'Sam' }, 'en');
    expect(textMe.wayOut).toBeUndefined();
    expect(textMe.mustMention).not.toContain('STOP');

    const ack = groupOnboardingLineInput({ kind: 'stop_ack' }, 'en');
    expect(ack.wayOut).toBe(true);
    expect(ack.mustMention).not.toContain('STOP');
  });

  it('echoes the role word someone already gave, and does not ask a question', () => {
    const confirmed = groupOnboardingLineInput(
      { kind: 'role_confirmed', name: 'Sam', role: 'aunt' },
      'en',
    );
    expect(confirmed.questions).toBe(0);
    expect(confirmed.mustMention).toEqual(['Sam', 'aunt']);
  });
});
