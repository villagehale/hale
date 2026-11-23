import { describe, expect, it } from 'vitest';
import {
  GROUP_JOIN_INTRO_SKILL,
  GROUP_ONBOARDING_SKILL,
  MIN_OTHER_PEOPLE_TO_REMOVE_HALE,
  groupJoinIntroClaims,
  groupOnboardingLineInput,
} from './group-onboarding-line-input';

/**
 * VIL-727 — the join intro's facts. Code decides which ground rules are true today and
 * hands the model only those; a rule that is not true is not in the list at all. The
 * model writes every word, so nothing here is a sentence.
 */

const LIT = { turnReaderLive: true, mailNoticeLive: false } as const;

describe('groupJoinIntroClaims', () => {
  it('states the rules that are true in a big household group with the turn reader lit', () => {
    expect(groupJoinIntroClaims({ audience: 'household', otherPeople: 4, ...LIT })).toEqual([
      'reads_this_chat',
      'email_never_shown',
      'speaks_when_called',
      'anyone_can_remove',
    ]);
  });

  it('leaves removal out until three other people are in the chat (Apple: four or more)', () => {
    expect(MIN_OTHER_PEOPLE_TO_REMOVE_HALE).toBe(3);
    for (const audience of ['household', 'shared'] as const) {
      for (const otherPeople of [0, 1, 2]) {
        expect(groupJoinIntroClaims({ audience, otherPeople, ...LIT })).not.toContain(
          'anyone_can_remove',
        );
      }
      expect(groupJoinIntroClaims({ audience, otherPeople: 3, ...LIT })).toContain(
        'anyone_can_remove',
      );
    }
  });

  it('says nothing about speaking in a household group the reader leaves silent, and never a private text', () => {
    expect(
      groupJoinIntroClaims({
        audience: 'household',
        otherPeople: 5,
        turnReaderLive: false,
        mailNoticeLive: false,
      }),
    ).toEqual(['reads_this_chat', 'email_never_shown', 'anyone_can_remove']);
  });

  it('keeps the speaking claim in a shared group and does not promise a private text', () => {
    expect(
      groupJoinIntroClaims({
        audience: 'shared',
        otherPeople: 5,
        turnReaderLive: false,
        mailNoticeLive: false,
      }),
    ).toEqual(['reads_this_chat', 'email_never_shown', 'speaks_when_called', 'anyone_can_remove']);
  });

  it('drops the email claim while the provider mail notice posts mail facts into the group', () => {
    for (const audience of ['household', 'shared'] as const) {
      expect(
        groupJoinIntroClaims({
          audience,
          otherPeople: 5,
          turnReaderLive: true,
          mailNoticeLive: true,
        }),
      ).not.toContain('email_never_shown');
    }
  });
});

describe('join_intro line input', () => {
  const claims = groupJoinIntroClaims({ audience: 'household', otherPeople: 4, ...LIT });

  it('hands a household intro its own skill, the facts, and one question when it asks', () => {
    const input = groupOnboardingLineInput(
      {
        kind: 'join_intro',
        audience: 'household',
        knownParentName: 'Riley',
        adderName: null,
        claims,
        ask: 'who_in_family',
      },
      'fr',
    );
    expect(input.skill).toBe(GROUP_JOIN_INTRO_SKILL);
    expect(input.kind).toBe('join_intro');
    expect(input.language).toBe('fr');
    expect(input.address).toBe('vous');
    expect(input.questions).toBe(1);
    expect(input.facts).toEqual({
      audience: 'household',
      knownParentName: 'Riley',
      adderName: null,
      claims,
      ask: 'who_in_family',
    });
    expect(input.mustMention).toEqual(['Hale', 'Riley']);
    expect(input.wayOut).toBeUndefined();
    expect(input.linkFollows).toBeUndefined();
  });

  it('asks nothing where everyone is known, and needs only Hale when no name is known', () => {
    const input = groupOnboardingLineInput(
      {
        kind: 'join_intro',
        audience: 'household',
        knownParentName: null,
        adderName: null,
        claims,
        ask: 'none',
      },
      'en',
    );
    expect(input.questions).toBe(0);
    expect(input.mustMention).toEqual(['Hale']);
  });

  it('names no household in a shared group, even when a parent name is passed', () => {
    const input = groupOnboardingLineInput(
      {
        kind: 'join_intro',
        audience: 'shared',
        knownParentName: 'Riley',
        adderName: 'Jordan',
        claims,
        ask: 'who_and_kid',
      },
      'es',
    );
    expect(input.facts.knownParentName).toBeNull();
    expect(input.facts.adderName).toBe('Jordan');
    expect(input.mustMention).toEqual(['Hale']);
    expect(input.questions).toBe(1);
    expect(JSON.stringify(input)).not.toContain('Riley');
  });

  it('carries no opt-out keyword and no role menu as a fact', () => {
    const input = groupOnboardingLineInput(
      {
        kind: 'join_intro',
        audience: 'household',
        knownParentName: 'Riley',
        adderName: null,
        claims,
        ask: 'who_in_family',
      },
      'en',
    );
    const text = JSON.stringify(input);
    for (const word of ['STOP', 'HELP', 'nanny', 'grandparent', 'babysitter']) {
      expect(text).not.toContain(word);
    }
  });

  it('leaves every other kind on the onboarding skill', () => {
    expect(
      groupOnboardingLineInput(
        { kind: 'roster_ask', knownParentName: 'Riley', rosterSize: 3 },
        'en',
      ).skill,
    ).toBe(GROUP_ONBOARDING_SKILL);
    expect(groupOnboardingLineInput({ kind: 'member_welcome', adderName: null }, 'en').skill).toBe(
      GROUP_ONBOARDING_SKILL,
    );
  });
});
