import { describe, expect, it } from 'vitest';
import { loadOnboardingFriendSkill } from '~/lib/cron/skill';
import {
  FRIEND_STEPS,
  type FriendVoiceInput,
  assembleFriendBody,
  fallbackFriendProse,
  friendWeekAction,
  judgeFriendReply,
  speakFriend,
} from './friend-voice';
import { FRIEND_CONVERSATIONS, fixtureBody } from './friend-voice-fixtures';
import { onboardingFriendVoiceEnabled } from './friend-voice-flag';
import { YEAR_OPEN_LEAD, YEAR_OPEN_LEAD_FR } from './year-open';

function blank(over: Partial<FriendVoiceInput> & Pick<FriendVoiceInput, 'step'>): FriendVoiceInput {
  return {
    language: 'en',
    address: 'tu',
    introduce: false,
    parentWords: 'hi',
    recentTurns: [],
    placeLabel: null,
    agesLabel: null,
    ageMonths: [],
    findLines: [],
    listKind: 'none',
    activity: null,
    day: null,
    parentName: null,
    ...over,
  };
}

describe('ONBOARDING_FRIEND_VOICE_ENABLED', () => {
  it('is on only for the exact word on, after trim', () => {
    expect(onboardingFriendVoiceEnabled({ ONBOARDING_FRIEND_VOICE_ENABLED: 'on' })).toBe(true);
    expect(onboardingFriendVoiceEnabled({ ONBOARDING_FRIEND_VOICE_ENABLED: '  on  ' })).toBe(true);
  });

  it('stays off when unset, and for true, 1, and ON', () => {
    expect(onboardingFriendVoiceEnabled({})).toBe(false);
    expect(onboardingFriendVoiceEnabled({ ONBOARDING_FRIEND_VOICE_ENABLED: 'true' })).toBe(false);
    expect(onboardingFriendVoiceEnabled({ ONBOARDING_FRIEND_VOICE_ENABLED: 'ON' })).toBe(false);
    expect(onboardingFriendVoiceEnabled({ ONBOARDING_FRIEND_VOICE_ENABLED: '1' })).toBe(false);
  });
});

describe('friend week find', () => {
  it('skips the week bubble once ages are known, and skips an empty list', () => {
    expect(friendWeekAction(true, 3)).toBe('skip');
    expect(friendWeekAction(true, 0)).toBe('skip');
    expect(friendWeekAction(false, 0)).toBe('ask_ages');
    expect(friendWeekAction(false, 2)).toBe('ask_ages_with_lines');
  });
});

describe('onboarding friend fixtures', () => {
  it('loads the direction skill by name', async () => {
    const skill = await loadOnboardingFriendSkill();
    expect(skill.meta.name).toBe('onboarding-friend');
    expect(skill.meta.task).toBe('speak');
    expect(skill.instructions).toContain('Exactly one question mark');
    expect(skill.instructions).toContain('Do not invent an activity');
    expect(skill.instructions).toContain('**coparent**');
    expect(skill.instructions).toContain('**connected**');
    expect(skill.instructions).toContain('**ack**');
    expect(skill.instructions).toContain('No STOP');
  });

  it('checks the three sample conversations', () => {
    expect(FRIEND_CONVERSATIONS).toHaveLength(3);
    for (const conversation of FRIEND_CONVERSATIONS) {
      for (const turn of conversation.turns) {
        const body = fixtureBody(turn);
        const judged = judgeFriendReply(body, turn.input, { link: turn.link ?? null });
        expect(judged, `${conversation.id} / ${turn.title} / ${body}`).toEqual({ ok: true });
        expect(body).not.toMatch(/reply with the number you want/i);
        expect(body).not.toMatch(/i'll note it/i);
        expect(body).not.toMatch(/text me if that changes/i);
        if (/\bthis link\b|\bce lien\b/i.test(body)) {
          expect(body).toContain('https://');
        }
      }
    }
  });

  it('puts the French year header and a receipt on the French find', () => {
    const french = FRIEND_CONVERSATIONS[1]?.turns[2];
    expect(french).toBeDefined();
    if (!french) return;
    const body = fixtureBody(french);
    expect(body).toContain(YEAR_OPEN_LEAD_FR);
    expect(body).toContain('près');
    expect(body).not.toContain(YEAR_OPEN_LEAD);
    expect(body).not.toMatch(/\bpres\b|\bage\b|\badapt\b/);
  });

  it('does not ask a second question when the first text already has everything', () => {
    const first = FRIEND_CONVERSATIONS[2]?.turns[0];
    expect(first).toBeDefined();
    if (!first) return;
    const body = fixtureBody(first);
    expect(body.match(/\?/g)).toHaveLength(1);
    expect(body).not.toMatch(/postal code/i);
    expect(body).toContain('Swim');
    expect(body).toContain('$12');
  });
});

describe('friend-voice judge', () => {
  const swim = blank({
    step: 'find_pick',
    parentWords: 'Maya is 4',
    placeLabel: 'M5V',
    findLines: ['Swim (ages 3-5) - Saturdays 10am - $12'],
    listKind: 'year',
    language: 'en',
  });

  it('rejects a second question, the stock lines, and an invented price', () => {
    const prose = 'Maya is 4, near M5V. Which of these feels right?';
    expect(judgeFriendReply(assembleFriendBody(prose, swim), swim)).toEqual({ ok: true });
    expect(judgeFriendReply(assembleFriendBody(`${prose} How old is she?`, swim), swim).ok).toBe(
      false,
    );
    expect(
      judgeFriendReply(assembleFriendBody('Which one? Reply with the number you want.', swim), swim)
        .ok,
    ).toBe(false);
    expect(
      judgeFriendReply(assembleFriendBody("I'll note it. Which of these?", swim), swim).ok,
    ).toBe(false);
    expect(
      judgeFriendReply(assembleFriendBody('Swim is $40 on Saturday. Which of these?', swim), swim)
        .ok,
    ).toBe(false);
  });

  it('rejects an empty find that still asks for a number', () => {
    const empty = blank({
      step: 'find_empty',
      language: 'en',
      parentWords: 'Maya is 4',
      placeLabel: 'M5V',
    });
    expect(
      judgeFriendReply('Nothing age-fit nearby yet. Reply with the number you want.', empty).ok,
    ).toBe(false);
    expect(judgeFriendReply('Nothing age-fit nearby yet. What should I call you?', empty)).toEqual({
      ok: true,
    });
  });

  it('requires the link when the ask says this link', () => {
    const calendar = blank({
      step: 'calendar',
      parentWords: 'Dana',
      parentName: 'Dana',
      activity: 'Swim',
    });
    const prose = 'Want me to check that swim against your calendar? This link is just for you.';
    expect(judgeFriendReply(prose, calendar).ok).toBe(false);
    const link = 'https://app.villagehale.com/connect?t=abc&to=gcal';
    expect(judgeFriendReply(`${prose}\n${link}`, calendar, { link })).toEqual({ ok: true });
  });

  it('rejects French with the ASCII gaps', () => {
    const ages = blank({ step: 'ages', language: 'fr', parentWords: 'H2X', placeLabel: 'H2X' });
    expect(judgeFriendReply('Quel age ont les enfants?', ages)).toEqual({
      ok: false,
      reason: 'french',
    });
    expect(judgeFriendReply('Quel âge ont les enfants?', ages)).toEqual({ ok: true });
  });

  it('keeps the coparent, connected, and ack fallbacks short and free of STOP', () => {
    const coparent = blank({ step: 'coparent', parentWords: 'ok' });
    expect(fallbackFriendProse(coparent)).toBe(
      "Want the other parent on the kids' year? Text me their number.",
    );
    expect(judgeFriendReply(fallbackFriendProse(coparent), coparent)).toEqual({ ok: true });

    const coparentVous = blank({
      step: 'coparent',
      language: 'fr',
      address: 'vous',
      parentWords: 'oui',
    });
    const vous = fallbackFriendProse(coparentVous);
    expect(vous).toContain('année');
    expect(vous).not.toMatch(/\bnumero\b/i);
    expect(judgeFriendReply(vous, coparentVous)).toEqual({ ok: true });

    const yes = blank({ step: 'ack', granted: true, parentWords: 'yes' });
    const no = blank({ step: 'ack', granted: false, parentWords: 'no thanks' });
    expect(fallbackFriendProse(yes)).toBe(
      "Done. You're covered. I'll text when something actually matters.",
    );
    expect(fallbackFriendProse(no)).toBe('No problem. Text me whenever you like.');
    expect(fallbackFriendProse(yes)).not.toMatch(/\?/);
    expect(fallbackFriendProse(no)).not.toMatch(/\?|\bSTOP\b/);
    expect(judgeFriendReply('Done. STOP always works.', yes)).toEqual({
      ok: false,
      reason: 'compliance',
    });

    const calendar = blank({ step: 'connected', connector: 'gcal', parentWords: '' });
    const gmail = blank({ step: 'connected', connector: 'gmail', language: 'fr', parentWords: '' });
    expect(fallbackFriendProse(calendar)).toBe('Your calendar is connected.');
    expect(fallbackFriendProse(gmail)).toBe('Ton Gmail est connecté.');
    expect(judgeFriendReply('Your Gmail is connected.', calendar)).toEqual({
      ok: false,
      reason: 'invented',
    });
    expect(judgeFriendReply(fallbackFriendProse(gmail), gmail)).toEqual({ ok: true });
  });

  it('accepts a fallback for every step', () => {
    for (const step of FRIEND_STEPS) {
      for (const language of ['en', 'fr'] as const) {
        const input = blank({
          step,
          language,
          parentWords: language === 'fr' ? 'Léa a 4 ans' : 'Maya is 4',
          placeLabel: 'M5V',
          activity: language === 'fr' ? 'Natation' : 'Swim',
          day: 'Saturday',
          parentName: 'Dana',
          findLines: step === 'find_pick' ? ['Swim (ages 3-5) - Saturdays 10am - $12'] : [],
          listKind: step === 'find_pick' ? 'year' : 'none',
          ageMonths: [48],
        });
        const body = assembleFriendBody(fallbackFriendProse(input), input, null);
        expect(judgeFriendReply(body, input), `${language} ${step}: ${body}`).toEqual({
          ok: true,
        });
        expect(body, `${language} ${step}`).not.toMatch(/\bSTOP\b|unsubscribe|d[ée]sabonner/i);
      }
    }
  });
});

describe('speakFriend', () => {
  it('names a missing composer and still returns one question', async () => {
    const input = blank({ step: 'place', introduce: true });
    const spoken = await speakFriend(undefined, input);
    expect(spoken.source).toBe('fallback');
    expect(spoken.fallback).toBe('voice_unavailable');
    expect(spoken.body.match(/\?/g)).toHaveLength(1);
    expect(judgeFriendReply(spoken.body, input)).toEqual({ ok: true });
  });

  it('keeps a composed reply that passes and drops one that does not', async () => {
    const input = blank({ step: 'ages', placeLabel: 'M5V' });
    const good = await speakFriend(
      {
        async compose() {
          return { reply: 'How old are the kids?' };
        },
      },
      input,
    );
    expect(good).toMatchObject({ source: 'composed', body: 'How old are the kids?' });

    const bad = await speakFriend(
      {
        async compose() {
          return { reply: "How old are the kids? I'll note it." };
        },
      },
      input,
    );
    expect(bad.source).toBe('fallback');
    expect(bad.body).not.toMatch(/i'll note it/i);
  });
});
