import { describe, expect, it } from 'vitest';
import { loadOnboardingFriendSkill } from '~/lib/cron/skill';
import {
  type FriendVoiceInput,
  assembleFriendBody,
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
    expect(friendWeekAction(false, 2)).toBe('ask_ages');
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

  it('puts the French find under the model lead, with the question last', () => {
    const french = FRIEND_CONVERSATIONS[1]?.turns[2];
    expect(french).toBeDefined();
    if (!french) return;
    const body = fixtureBody(french);
    expect(body).toContain('près');
    expect(body).toContain('1. ');
    expect(body.trim().endsWith('?')).toBe(true);
    expect(body).not.toContain(YEAR_OPEN_LEAD);
    expect(body).not.toContain(YEAR_OPEN_LEAD_FR);
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

  it('puts the question after the list, and rejects a question that sits above it', () => {
    const prose = 'Maya is 4 and Leo is 1, near M5V. Which of these feels right?';
    const body = assembleFriendBody(prose, swim);
    const lines = body.split('\n');
    expect(lines.at(-1)).toBe('Which of these feels right?');
    expect(body).not.toContain(YEAR_OPEN_LEAD);
    expect(body.indexOf('1. ')).toBeLessThan(body.lastIndexOf('?'));
    expect(judgeFriendReply(body, swim)).toEqual({ ok: true });
    const buried = `How old are the kids?\n${YEAR_OPEN_LEAD}\n1. Swim (ages 3-5) - Saturdays 10am - $12`;
    expect(judgeFriendReply(buried, swim)).toEqual({ ok: false, reason: 'question' });
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
    const prose = 'This link is just for you. Want me to check that swim against your calendar?';
    expect(judgeFriendReply(prose, calendar).ok).toBe(false);
    const link = 'https://app.villagehale.com/connect?t=abc&to=gcal';
    expect(judgeFriendReply(`${prose}\n${link}`, calendar, { link })).toEqual({ ok: true });
  });

  it('requires the question to end the message, and does not grade the aside', () => {
    const place = blank({ step: 'place', parentWords: 'what is this?', listKind: 'none' });
    expect(
      judgeFriendReply("It's a text for your kids' year. What's your postal code?", place),
    ).toEqual({ ok: true });
    expect(
      judgeFriendReply("What's your postal code? It's a text for your kids' year.", place),
    ).toEqual({ ok: false, reason: 'question' });
  });

  it('rejects French with the ASCII gaps', () => {
    const ages = blank({ step: 'ages', language: 'fr', parentWords: 'H2X', placeLabel: 'H2X' });
    expect(judgeFriendReply('Quel age ont les enfants?', ages)).toEqual({
      ok: false,
      reason: 'french',
    });
    expect(judgeFriendReply('Quel âge ont les enfants?', ages)).toEqual({ ok: true });
  });

  it('rejects STOP and a connector named on the wrong step', () => {
    const yes = blank({ step: 'ack', granted: true, parentWords: 'yes' });
    expect(judgeFriendReply('Done. STOP always works.', yes)).toEqual({
      ok: false,
      reason: 'compliance',
    });
    expect(judgeFriendReply("Done. You're covered.", yes)).toEqual({ ok: true });

    const calendar = blank({ step: 'connected', connector: 'gcal', parentWords: '' });
    const gmail = blank({ step: 'connected', connector: 'gmail', language: 'fr', parentWords: '' });
    expect(judgeFriendReply('Your Gmail is connected.', calendar)).toEqual({
      ok: false,
      reason: 'invented',
    });
    expect(judgeFriendReply('Ton Gmail est connecté.', gmail)).toEqual({ ok: true });
  });
});

describe('speakFriend', () => {
  it('pages and sends nothing when the composer is missing', async () => {
    const input = blank({ step: 'ages', parentWords: 'Maya is 4', placeLabel: 'M5V' });
    const pages: string[] = [];
    const spoken = await speakFriend(undefined, input, {
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(spoken).toMatchObject({ source: 'unsent', body: '', fallback: 'voice_unavailable' });
    expect(pages).toEqual(['onboarding friend voice unsent step=ages reason=voice_unavailable']);
    expect(pages.join(' ')).not.toContain('Maya');
    expect(spoken.body).not.toBe('How old are the kids?');
  });

  it('keeps a composed reply and retries once on a smaller prompt', async () => {
    const input = blank({ step: 'ages', placeLabel: 'M5V', parentWords: 'And' });
    const good = await speakFriend(
      {
        async compose() {
          return { reply: 'How old are your kids?' };
        },
      },
      input,
    );
    expect(good).toMatchObject({ source: 'composed', body: 'How old are your kids?' });

    const prompts: string[] = [];
    const retried = await speakFriend(
      {
        async compose(_input, options) {
          prompts.push(options?.prompt ?? 'full');
          if (options?.prompt === 'short') return { reply: 'How old are your kids?' };
          return { reply: "How old are the kids? I'll note it." };
        },
      },
      input,
    );
    expect(prompts).toEqual(['full', 'short']);
    expect(retried).toMatchObject({ source: 'retry', body: 'How old are your kids?' });
    expect(retried.body).not.toMatch(/i'll note it/i);
  });

  it('sends nothing and pages when both attempts fail', async () => {
    const input = blank({ step: 'ages', parentWords: 'secret words', placeLabel: 'M5V' });
    const pages: string[] = [];
    const spoken = await speakFriend(
      {
        async compose() {
          return { reply: "How old are the kids? I'll note it." };
        },
      },
      input,
      {
        page: async (text) => {
          pages.push(text);
        },
        attemptTimeoutMs: 1_000,
      },
    );
    expect(spoken.source).toBe('unsent');
    expect(spoken.body).toBe('');
    expect(pages).toHaveLength(1);
    expect(pages[0]).not.toContain('secret');
    expect(spoken.body).not.toBe('How old are the kids?');
  });

  it('judges a yes as the next ask, so camp email is not an invented activity', async () => {
    const input = blank({
      step: 'calendar',
      parentWords: 'yes',
      checklist: {
        postal: true,
        ages: true,
        pick: true,
        name: true,
        kids: true,
        calendar: false,
        gmail: false,
      },
    });
    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch school and camp email for the dates?',
            capture: { connectCalendar: true },
          };
        },
      },
      input,
      { page: async () => undefined },
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.capture.connectCalendar).toBe(true);
    expect(spoken.body).toMatch(/camp email/i);
  });
});
