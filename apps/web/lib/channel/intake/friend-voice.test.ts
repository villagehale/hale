import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOnboardingFriendShortSkill, loadOnboardingFriendSkill } from '~/lib/cron/skill';
import {
  type FriendVoiceInput,
  assembleFindShowBubbles,
  assembleFriendBody,
  friendVoiceContext,
  friendWeekAction,
  judgeFriendReply,
  lastInboundFact,
  readGroupLeads,
  repairedProse,
  speakFriend,
} from './friend-voice';
import { FRIEND_CONVERSATIONS, fixtureBody } from './friend-voice-fixtures';

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

describe('friend voice brief', () => {
  it('gives the elapsed time for a several-hours-old text and does not flag a two-minute one', () => {
    // 2:00 p.m. America/Toronto. Five hours earlier is 9:00 a.m., after quiet hours end.
    const now = new Date('2026-08-28T18:00:00.000Z');
    const hoursOld = new Date(now.getTime() - 5 * 3_600_000);
    const brief = friendVoiceContext(
      blank({
        step: 'place',
        introduce: true,
        parentWords: 'hi',
        lastInbound: lastInboundFact(hoursOld, now),
      }),
    );
    expect(brief).toMatchObject({
      lastInbound: { minutesAgo: 300, overnight: false, yesterday: false },
    });
    expect(JSON.stringify(brief)).not.toMatch(/sorry|apolog|error|fault|delay/i);

    const justNow = friendVoiceContext(
      blank({
        step: 'place',
        introduce: true,
        parentWords: 'hi',
        lastInbound: lastInboundFact(new Date(now.getTime() - 2 * 60_000), now),
      }),
    );
    expect(justNow).not.toHaveProperty('lastInbound');

    // 11:30 p.m. Toronto, answered at 8:00 a.m. when quiet hours end.
    const late = new Date('2026-08-29T03:30:00.000Z');
    const morning = new Date('2026-08-29T12:00:00.000Z');
    const pickedUp = friendVoiceContext(
      blank({
        step: 'place',
        introduce: true,
        parentWords: 'hi',
        lastInbound: lastInboundFact(late, morning),
      }),
    );
    expect(pickedUp).toMatchObject({
      lastInbound: { minutesAgo: 8 * 60 + 30, overnight: true, yesterday: true },
    });
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
    expect(skill.instructions).toContain('Never name a town, neighbourhood, school, venue, date');
    expect(skill.instructions).toContain('**coparent**');
    expect(skill.instructions).toContain('**connected**');
    expect(skill.instructions).toContain('ahaMention');
    expect(skill.instructions).toContain('**ack**');
    expect(skill.instructions).toContain('No STOP');
    expect(skill.instructions).toContain('`lastInbound`');
    expect(skill.instructions).toContain('minutesAgo');
  });

  it('stays lean: state and a playbook, with the gates left to code', async () => {
    const skill = await loadOnboardingFriendSkill();
    const words = skill.instructions.split(/\s+/).filter(Boolean).length;
    const ruleWords = skill.instructions.match(/\b(never|do not|don't|always)\b/gi) ?? [];
    expect(words).toBeLessThan(2400);
    expect(ruleWords.length).toBeLessThan(20);
    expect(skill.instructions).toContain('## Facts');
    expect(skill.instructions).toContain('## Output');
    expect(skill.instructions).toContain('reminders, not registrations');
    expect(skill.instructions).toContain('Propose a default per item');
    // The trust lines are true for a full-read Google scope: no "never sees your mail".
    expect(skill.instructions).not.toMatch(/never sees? your (personal|work) (mail|email)/i);
    expect(skill.instructions).toContain(
      'Never claim Hale only reads, only sees, or never sees some of it',
    );

    // The retry prompt is a skill too, and knows the step it is rewriting.
    const short = await loadOnboardingFriendShortSkill();
    const shortWords = short.instructions.split(/\s+/).filter(Boolean).length;
    expect(shortWords).toBeLessThan(700);
    expect(short.instructions).toContain('**find_show**');
    expect(short.instructions).toContain('**connected**');
    expect(short.instructions).toContain('lastInbound');
    expect(short.meta.task).toBe('speak');
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

  it('shows the map with no question when the first text already has everything, then asks the name', () => {
    const [first, second] = FRIEND_CONVERSATIONS[2]?.turns ?? [];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) return;
    const body = fixtureBody(first);
    expect(body).not.toContain('?');
    expect(body).not.toMatch(/postal code/i);
    expect(body).not.toMatch(/which (one|of these)/i);
    expect(body).toContain('Swim');
    expect(body).toContain('$12');
    const name = fixtureBody(second);
    expect(name.match(/\?/g)).toHaveLength(1);
    expect(name).toMatch(/call you/i);
  });

  it('never puts a which-one ask or a second question on the map', () => {
    for (const conversation of FRIEND_CONVERSATIONS) {
      for (const turn of conversation.turns) {
        if (turn.input.step !== 'find_show') continue;
        const body = fixtureBody(turn);
        expect(body, `${conversation.id} / ${turn.title}`).not.toContain('?');
        const bubbles = body.split('\n\n');
        expect(bubbles.length).toBeGreaterThanOrEqual(2);
        expect(bubbles.length).toBeLessThanOrEqual(4);
        for (const line of turn.input.findLines) expect(body).toContain(line);
      }
    }
  });
});

describe('friend-voice judge', () => {
  it('does not refuse a long reply: length is not a reason', () => {
    const prose = `${'Got it, I can look near you for what fits the kids. '.repeat(30)}What's your postal code?`;
    expect(prose.length).toBeGreaterThan(1200);
    expect(judgeFriendReply(prose, blank({ step: 'place', parentWords: 'hi' }))).toEqual({
      ok: true,
    });
  });

  // A list with one question: the legacy numbered find a nudge still sends.
  const swim = blank({
    step: 'nudge_find',
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
    const prose = 'This link is just for you. Want me to check that swim against your calendar?';
    expect(judgeFriendReply(prose, calendar).ok).toBe(false);
    const link = 'https://app.villagehale.com/connect?t=abc&to=gcal';
    expect(judgeFriendReply(`${prose}\n${link}`, calendar, { link })).toEqual({ ok: true });
  });

  it('lets the aside follow the question: one ask, wherever it sits', () => {
    const place = blank({ step: 'place', parentWords: 'what is this?', listKind: 'none' });
    expect(
      judgeFriendReply("It's a text for your kids' year. What's your postal code?", place),
    ).toEqual({ ok: true });
    expect(
      judgeFriendReply("What's your postal code? It's a text for your kids' year.", place),
    ).toEqual({ ok: true });
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
    expect(judgeFriendReply('Your Gmail is connected.', calendar)).toMatchObject({
      ok: false,
      reason: 'invented',
    });
    expect(judgeFriendReply('Ton Gmail est connecté.', gmail)).toEqual({ ok: true });
  });

  it('refuses every way of claiming a registration Hale did not make, and keeps the reminder wording', () => {
    const schedule = blank({
      step: 'schedule',
      parentWords: 'yes',
      findLines: ['Swim Kids 3 (ages 6-8) - Saturdays 11:00'],
      now: new Date('2026-10-05T14:00:00Z'),
    });
    for (const claim of [
      "Done, she's signed up for Swim Kids. Anything else?",
      'Mia is registered for swim on Saturdays. Anything else?',
      'I signed Mia up for swim. Anything else?',
      "She's signed-up for swim. Anything else?",
      "You're booked for swim Saturday. Anything else?",
    ]) {
      expect(judgeFriendReply(claim, schedule)).toEqual({
        ok: false,
        reason: 'registration_claim',
      });
    }
    expect(
      judgeFriendReply(
        "Swim is on your calendar as a reminder for Saturdays at 11:00; I'll flag it when registration opens. Anything else?",
        schedule,
      ),
    ).toEqual({ ok: true });
  });

  it('answers who-is-this in the model voice, but only when the company is named', () => {
    const asked = blank({
      step: 'kids_names',
      placeLabel: 'Burlington',
      parentWords: 'wait who is this? is this free?',
      identityAsked: true,
    });
    expect(
      judgeFriendReply(
        "Fair question. I'm Hale, from Village Hale Technologies (villagehale.com) - I find kids' activities near you and keep the dates straight. Pricing isn't mine to quote; the site has it. Who are the kids?",
        asked,
      ),
    ).toEqual({ ok: true });
    expect(
      judgeFriendReply("I'm Hale, a text helper for parents. Who are the kids?", asked),
    ).toEqual({ ok: false, reason: 'identity' });
    // A fixed-copy shape, with STOP in it, is not what the model writes.
    expect(
      judgeFriendReply(
        'This is Hale from Village Hale Technologies Inc. Reply STOP anytime and we stop. Who are the kids?',
        asked,
      ),
    ).toEqual({ ok: false, reason: 'compliance' });
    // A parent who is not challenging Hale is not made to hear the company name.
    const plain = blank({ step: 'kids_names', placeLabel: 'Burlington', parentWords: 'L7G 4S8' });
    expect(judgeFriendReply('Burlington, got it. Who are the kids?', plain)).toEqual({ ok: true });
  });

  it('lets a connected reply name one synced title, and nothing the snapshot does not have', () => {
    const synced = {
      provider: 'gcal' as const,
      read: 'ok' as const,
      calendar: [
        {
          title: 'Swim at the rec centre',
          start: '2026-09-12T13:00:00.000Z',
          end: '2026-09-12T14:00:00.000Z',
          allDay: false,
          location: null,
          declined: false,
        },
      ],
      email: [],
      overlaps: [],
    };
    const input = blank({ step: 'connected', connector: 'gcal', parentWords: '', synced });
    expect(
      judgeFriendReply('Swim at the rec centre is on your calendar.', input, {
        ahaMention: 'Swim at the rec centre',
      }),
    ).toEqual({ ok: true });
    expect(
      judgeFriendReply('Swim at the rec centre is on your calendar.', input, { ahaMention: null }),
    ).toEqual({ ok: true });
    expect(judgeFriendReply('Your calendar is connected.', input, { ahaMention: null })).toEqual({
      ok: true,
    });
    expect(
      judgeFriendReply('Hockey is on Thursday at 4:00.', input, { ahaMention: 'Hockey' }),
    ).toMatchObject({ ok: false, reason: 'invented' });
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

  it('does not page when the retry recovers, and marks the recovery', async () => {
    const pages: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spoken = await speakFriend(
        {
          async compose(_input, options) {
            if (options?.prompt === 'short') return { reply: 'How old are your kids?' };
            return { reply: "How old are the kids? I'll note it." };
          },
        },
        blank({ step: 'ages', parentWords: 'Maya is 4', placeLabel: 'M5V' }),
        {
          page: async (text) => {
            pages.push(text);
          },
        },
      );
      expect(spoken).toMatchObject({ source: 'retry', body: 'How old are your kids?' });
      expect(pages).toEqual([]);
      const errors = error.mock.calls.map((call) => call.at(-1));
      expect(errors).not.toContain('onboarding-friend: unusable reply');
      expect(errors).not.toContain('onboarding-friend: reply not sent');
      expect(warn.mock.calls.map((call) => call.at(-1))).toContain(
        'onboarding-friend: attempt refused',
      );
      expect(info.mock.calls).toContainEqual([
        { recovered: true, step: 'ages' },
        'onboarding-friend: retry recovered',
      ]);
    } finally {
      info.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps a long find_show opener and a long model-written map, and does not page', async () => {
    const pages: string[] = [];
    const opener =
      'I looked near you for what fits this week, and these are the ones that came up from the city pages for their ages, the ones worth a look before the week fills up.';
    expect(opener.length).toBeGreaterThan(120);
    const line = 'Swim at the rec centre (ages 3-5) - Saturday morning at the community pool';
    const lines = Array.from({ length: 24 }, (_, index) => `${line} session ${index + 1}`);
    const lead = lines.join('\n');
    expect(lead.length).toBeGreaterThan(1200);
    const spoken = await speakFriend(
      {
        async compose() {
          return { reply: opener, groupLeads: [lead] };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        findLines: lines,
        findGroups: [{ category: 'swimming', lines }],
      }),
      {
        page: async (text) => {
          pages.push(text);
        },
      },
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.fallback).toBeNull();
    expect(spoken.bubbles).toEqual([opener, lead]);
    expect(spoken.body.length).toBeGreaterThan(1200);
    expect(spoken.body).not.toMatch(/^\d+\.\s/m);
    expect(pages).toEqual([]);
    expect(spoken.body).not.toContain('?');
  });

  it('sends the model find_show bubble and does not number the found line under it', async () => {
    const swim = 'Swim at the rec centre (ages 3-5) - Saturday 10:00';
    const lead = 'Swim at the rec centre for ages 3-5, Saturday at 10:00.';
    const spoken = await speakFriend(
      {
        async compose() {
          return { reply: 'Here is what is on near you.', groupLeads: [lead] };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        findLines: [swim],
        findGroups: [{ category: 'swimming', lines: [swim] }],
      }),
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.bubbles).toEqual(['Here is what is on near you.', lead]);
    expect(spoken.body).toContain('10:00');
    expect(spoken.body).not.toMatch(/^\d+\.\s/m);
  });

  it('skips a find_show group with no lead and sends nothing when no bubble was written', async () => {
    const swim = 'Swim at the rec centre (ages 3-5) - Saturday';
    const story = 'Story time (all ages) - Tuesday';
    const groups = [
      { category: 'swimming', lines: [swim] },
      { category: 'parent_baby', lines: [story] },
    ];
    const partial = assembleFindShowBubbles('Here is what is on near you.', groups, [
      'Saturday swim at the rec centre, ages 3-5.',
      '',
    ]);
    expect(partial).toEqual([
      'Here is what is on near you.',
      'Saturday swim at the rec centre, ages 3-5.',
    ]);
    expect(partial.join('\n')).not.toContain(story);
    expect(partial.join('\n')).not.toMatch(/^\d+\.\s/m);

    const pages: string[] = [];
    const unsent = await speakFriend(
      {
        async compose() {
          return { reply: '?', groupLeads: ['', ''] };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        findLines: [swim, story],
        findGroups: groups,
      }),
      {
        page: async (text) => {
          pages.push(text);
        },
      },
    );
    expect(unsent).toMatchObject({ source: 'unsent', body: '', bubbles: [] });
    expect(unsent.body).not.toMatch(/^\d+\.\s/m);
    expect(unsent.body).not.toContain(swim);
    expect(pages).toHaveLength(1);
  });

  it('counts a multiline groupLeads entry as one bubble', async () => {
    const swimLead = 'Swim at the rec centre for ages 3-5.\nSaturday at 10:00.';
    const storyLead = 'Story time for all ages.\nTuesday at 11:00.';
    const swim = 'Swim at the rec centre (ages 3-5) - Saturday 10:00';
    const story = 'Story time (all ages) - Tuesday 11:00';
    expect(readGroupLeads([swimLead, storyLead])).toEqual([swimLead, storyLead]);
    expect(readGroupLeads('Swim\nStory time')).toEqual(['Swim', 'Story time']);

    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Here is what is on near you.',
            groupLeads: readGroupLeads([swimLead, storyLead]),
          };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        findLines: [swim, story],
        findGroups: [
          { category: 'swimming', lines: [swim] },
          { category: 'story', lines: [story] },
        ],
      }),
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.bubbles).toEqual(['Here is what is on near you.', swimLead, storyLead]);
    expect(spoken.bubbles).toHaveLength(3);
  });

  it('does not send a find_show opener when no group bubble was written', async () => {
    const prompts: string[] = [];
    const opener = 'Here is what is on near you.';
    const swim = 'Swim at the rec centre (ages 3-5) - Saturday 10:00';
    const spoken = await speakFriend(
      {
        async compose(input, options) {
          prompts.push(options?.prompt ?? 'full');
          if (options?.prompt === 'short') {
            expect(input.retry?.problem).toBe('no_group_bubble');
          }
          return { reply: opener, groupLeads: null };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        findLines: [swim],
        findGroups: [{ category: 'swimming', lines: [swim] }],
      }),
      { page: async () => undefined },
    );
    expect(prompts).toEqual(['full', 'short']);
    expect(spoken).toMatchObject({ source: 'unsent', body: '', bubbles: [] });
    expect(spoken.body).not.toContain(opener);
    expect(spoken.body).not.toContain(swim);
  });

  it("does not send a group bubble that uses another group's time", async () => {
    const swim = 'Swim at the rec centre (ages 3-5) - Saturday 10:00';
    const story = 'Story time (all ages) - Tuesday 11:00';
    const storyLead = 'Story time for all ages, Tuesday at 11:00.';
    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Here is what is on near you.',
            groupLeads: ['Swim on Tuesday at 11:00.', storyLead],
          };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        findLines: [swim, story],
        findGroups: [
          { category: 'swimming', lines: [swim] },
          { category: 'story', lines: [story] },
        ],
      }),
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.bubbles).toEqual(['Here is what is on near you.', storyLead]);
    expect(spoken.body).not.toMatch(/swim on tuesday/i);
  });

  it('keeps a group bubble that names the weekday of a date in that group’s line', async () => {
    const story = 'Story time (all ages) - October 14';
    const lead = 'Story time on Wednesday, October 14.';
    const spoken = await speakFriend(
      {
        async compose() {
          return { reply: 'Here is what is on near you.', groupLeads: [lead] };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        now: new Date('2026-10-05T14:00:00Z'),
        findLines: [story],
        findGroups: [{ category: 'story', lines: [story] }],
      }),
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.bubbles).toEqual(['Here is what is on near you.', lead]);
  });

  it('does not treat this year’s weekday as the weekday of a later year on the line', async () => {
    const line = 'Story time (all ages) - October 14, 2027';
    const wrong = 'Story time on Wednesday, October 14.';
    const right = 'Story time on Thursday, October 14, 2027.';
    const spoken = await speakFriend(
      {
        async compose() {
          return { reply: 'Here is what is on near you.', groupLeads: [wrong, right] };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        now: new Date('2026-10-05T14:00:00Z'),
        findLines: [line, line],
        findGroups: [
          { category: 'story', lines: [line] },
          { category: 'story_later', lines: [line] },
        ],
      }),
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.bubbles).toEqual(['Here is what is on near you.', right]);
    expect(spoken.body).not.toMatch(/wednesday/i);
  });

  it('does not invent a weekday for a month and year that name no day', async () => {
    const line = 'Story time (all ages) - May 2027';
    const lead = 'Story time on Wednesday in May 2027.';
    const spoken = await speakFriend(
      {
        async compose() {
          return { reply: 'Here is what is on near you.', groupLeads: [lead] };
        },
      },
      blank({
        step: 'find_show',
        parentWords: 'she is 4',
        placeLabel: 'M5V',
        now: new Date('2026-04-05T14:00:00Z'),
        findLines: [line],
        findGroups: [{ category: 'story', lines: [line] }],
      }),
      { page: async () => undefined },
    );
    expect(spoken.source).toBe('unsent');
    expect(spoken.body).not.toMatch(/wednesday/i);
  });

  it('keeps a nine-line onboarding map whole, and still numbers only three lines on a year list', () => {
    const lines = Array.from(
      { length: 9 },
      (_, index) => `Activity ${index + 1} at the pool (ages 3-5) - Saturday`,
    );
    const groups = [0, 1, 2].map((group) => ({
      category: `group-${group}`,
      lines: lines.slice(group * 3, group * 3 + 3),
    }));
    const leads = groups.map((group) => group.lines.join('\n'));
    const bubbles = assembleFindShowBubbles('Near you for their ages.', groups, leads);
    expect(bubbles).toEqual(['Near you for their ages.', ...leads]);
    const map = bubbles.join('\n');
    for (const line of lines) expect(map).toContain(line);
    expect(map).not.toMatch(/^\d+\.\s/m);

    const year = assembleFriendBody(
      'A few that fit.',
      blank({
        step: 'nudge_find',
        parentWords: 'Maya is 4',
        placeLabel: 'M5V',
        findLines: lines,
        listKind: 'year',
      }),
    );
    expect(year).toContain('1. Activity 1 at the pool (ages 3-5) - Saturday');
    expect(year).toContain('3. Activity 3 at the pool (ages 3-5) - Saturday');
    expect(year).not.toContain('4. Activity 4 at the pool (ages 3-5) - Saturday');
  });

  it('never sends a reply that confirmed an add code refused; the retry with real adds goes out', async () => {
    const input = blank({
      step: 'schedule',
      parentWords:
        "Put Mia's swim on weekly please. And the library drop-in for Seb, just this Thursday",
      placeLabel: 'Burlington',
      agesLabel: 'Sebastian (1) and Mia (6)',
      ageMonths: [15, 72],
      children: [
        { name: 'Sebastian', ageMonths: 15 },
        { name: 'Mia', ageMonths: 72 },
      ],
      findLines: [
        'Parent and Tot Swim (6-36 months) - Saturdays 10:00',
        'Swim Kids 3 (ages 6-8) - Saturdays 11:00',
        'Family Storytime drop-in (ages 0-5) - Thursdays 10:30',
      ],
      now: new Date('2026-10-05T14:00:00Z'),
    });
    const seen: Array<{ prompt: string; children: unknown }> = [];
    const spoken = await speakFriend(
      {
        async compose(given, options) {
          seen.push({ prompt: options?.prompt ?? 'full', children: given.children });
          if (options?.prompt === 'short') {
            return {
              reply:
                "Both are on as reminders: Mia's Swim Kids Saturdays at 11:00 weekly, Seb's storytime Thursday at 10:30. Anything else from the list?",
              capture: {
                scheduleAdds: [
                  { line: 2, cadence: 'weekly', date: '2026-10-10', time: '11:00' },
                  { line: 3, cadence: 'once', date: '2026-10-08', time: '10:30' },
                ],
              },
            };
          }
          // The full draft confirmed a swim with no settled date and a line off the map.
          return {
            reply: "Done: Mia's swim weekly and Seb's drop-in Thursday, as reminders.",
            capture: {
              scheduleAdds: [
                { line: 2, cadence: 'weekly' },
                { line: 7, cadence: 'once', date: '2026-10-08' },
              ],
            },
          };
        },
      },
      input,
    );
    expect(seen.map((call) => call.prompt)).toEqual(['full', 'short']);
    expect(seen[0]?.children).toEqual(input.children);
    expect(spoken.source).toBe('retry');
    expect(spoken.capture.scheduleAdds.map((add) => add.line)).toEqual([2, 3]);
    expect(spoken.body).toContain('11:00');
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

  it('judges a yes to a connector as that connector step: a receipt with no question passes, the next ask does not ride it', async () => {
    const input = blank({
      step: 'calendar',
      parentWords: 'yes',
      checklist: {
        postal: true,
        ages: true,
        name: true,
        kids: true,
        calendar: false,
        gmail: false,
        schedule: false,
        coparent: false,
      },
    });
    const receipt = await speakFriend(
      {
        async compose() {
          return {
            reply: "Great, the link is right there. Tap it and I'll text you what I see.",
            capture: { connectCalendar: true },
          };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(receipt.source).toBe('composed');
    expect(receipt.step).toBe('calendar');
    expect(receipt.capture.connectCalendar).toBe(true);
    expect(receipt.body).not.toContain('?');

    // Prose about Gmail under the calendar card sends the parent to the wrong link.
    const pivot = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch Gmail for the dates too?',
            capture: { connectCalendar: true },
          };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(pivot.source).toBe('unsent');
  });

  it('sends nothing when both find_show openers fail, and still pages', async () => {
    const pages: string[] = [];
    const input = blank({
      step: 'find_show',
      parentWords: "she's 4",
      findLines: [
        'Swim at the rec centre (ages 3-5) - Saturday',
        'Story time (all ages) - Tuesday',
      ],
      findGroups: [
        { category: 'swimming', lines: ['Swim at the rec centre (ages 3-5) - Saturday'] },
        { category: 'parent_baby', lines: ['Story time (all ages) - Tuesday'] },
      ],
    });
    const spoken = await speakFriend(
      {
        async compose() {
          throw new Error('model down');
        },
      },
      input,
      { page: async (text) => pages.push(text) },
    );
    expect(spoken).toMatchObject({
      source: 'unsent',
      body: '',
      prose: '',
      bubbles: [],
      fallback: 'model_failed',
    });
    expect(spoken.body).not.toMatch(/^\d+\.\s/m);
    expect(pages).toHaveLength(1);
  });

  it('sends nothing on find_show when the composer is missing', async () => {
    const pages: string[] = [];
    const spoken = await speakFriend(
      undefined,
      blank({
        step: 'find_show',
        parentWords: "she's 4",
        findLines: ['Swim at the rec centre (ages 3-5) - Saturday'],
        findGroups: [
          { category: 'swimming', lines: ['Swim at the rec centre (ages 3-5) - Saturday'] },
        ],
      }),
      {
        page: async (text) => {
          pages.push(text);
        },
      },
    );
    expect(spoken).toMatchObject({
      source: 'unsent',
      body: '',
      bubbles: [],
      fallback: 'voice_unavailable',
    });
    expect(pages).toEqual([
      'onboarding friend voice unsent step=find_show reason=voice_unavailable',
    ]);
  });

  it('judges a wow line on the fact, not the spelling: a weekday from the subject and a clock from the start pass', () => {
    const input = blank({
      step: 'connected',
      connector: 'gmail',
      synced: {
        provider: 'gmail',
        read: 'ok',
        calendar: [],
        email: [
          {
            subject: 'Picture Day at Park Public School Thu Oct 8',
            fromName: 'Park Public School',
            receivedAt: '2026-10-05T14:00:00.000Z',
            snippet: 'Order forms are due Wednesday.',
          },
        ],
        overlaps: [],
      },
    });
    expect(
      judgeFriendReply(
        'Saw the picture day at Park Public School on Thursday in your inbox. Want a reminder the evening before?',
        input,
        { ahaMention: 'Picture Day at Park Public School Thu Oct 8' },
      ),
    ).toEqual({ ok: false, reason: 'question' });
    expect(
      judgeFriendReply(
        'Saw the picture day at Park Public School on Thursday in your inbox. I can remind you the evening before.',
        input,
        { ahaMention: 'Picture Day at Park Public School Thu Oct 8' },
      ),
    ).toEqual({ ok: true });
    // A weekday the subject does not carry is still invented.
    expect(
      judgeFriendReply(
        'Saw the picture day at Park Public School on Friday in your inbox. I can remind you the evening before.',
        input,
        { ahaMention: 'Picture Day at Park Public School Thu Oct 8' },
      ),
    ).toMatchObject({ ok: false, reason: 'invented' });

    const clash = blank({
      step: 'connected',
      connector: 'gcal',
      synced: {
        provider: 'gcal',
        read: 'ok',
        calendar: [
          {
            title: 'Mia swim',
            start: '2026-10-17T14:00:00.000Z',
            end: '2026-10-17T14:45:00.000Z',
            allDay: false,
            location: null,
            declined: false,
          },
          {
            title: 'Mia birthday party',
            start: '2026-10-17T14:15:00.000Z',
            end: '2026-10-17T16:00:00.000Z',
            allDay: false,
            location: null,
            declined: false,
          },
        ],
        email: [],
        overlaps: [{ earlier: 'Mia swim', later: 'Mia birthday party' }],
      },
    });
    expect(
      judgeFriendReply(
        "Mia's swim and the Mia birthday party both start around 10:00 on Saturday the 17th, so they clash. I can flag it the evening before.",
        clash,
        { ahaMention: 'Mia swim' },
      ),
    ).toEqual({ ok: true });
  });
});

describe('the co-parent step: their group, or a new one', () => {
  const join = { line: '+1 555-555-0100', phrase: 'this is our year' };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function coparentTurn(parentWords: string, withJoin = true): FriendVoiceInput {
    return blank({
      step: 'coparent',
      parentWords,
      recentTurns: [
        {
          role: 'hale',
          body: 'Want me in your family group, or a new group with the other parent?',
        },
      ],
      coparentJoin: withJoin ? join : null,
      checklist: {
        postal: true,
        kids: true,
        ages: true,
        name: true,
        gmail: true,
        calendar: true,
        schedule: true,
        coparent: false,
      },
    });
  }

  async function read(parentWords: string, capture: Record<string, unknown>, withJoin = true) {
    return speakFriend(
      {
        async compose() {
          return { reply: 'Great, the number is below for whenever you want.', capture };
        },
      },
      coparentTurn(parentWords, withJoin),
      { page: async () => undefined },
    );
  }

  it('with the flag off, a yes is not their existing group, even when the words name one', async () => {
    const spoken = await read('yes add you to our group', {
      coparentGroup: true,
      coparentGroupMode: 'existing',
    });
    expect(spoken.capture.coparentGroup).toBe(true);
    expect(spoken.capture.coparentGroupMode).toBeNull();
    const plain = await read('yes', { coparentGroup: true, coparentGroupMode: 'existing' });
    expect(plain.capture.coparentGroupMode).toBeNull();
  });

  it('with the flag on, keeps the model reading and does not default a plain yes', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const existing = await read('yes add you to our group', {
      coparentGroup: true,
      coparentGroupMode: 'new',
    });
    expect(existing.capture.coparentGroupMode).toBe('new');
    const fresh = await read("let's start a new group", {
      coparentGroup: true,
      coparentGroupMode: 'existing',
    });
    expect(fresh.capture.coparentGroupMode).toBe('existing');
    const plain = await read('yes', { coparentGroup: true, coparentGroupMode: null });
    expect(plain.capture.coparentGroup).toBe(true);
    expect(plain.capture.coparentGroupMode).toBeNull();
  });

  it('with the flag on, an existing group this chat cannot hold becomes a new one', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const spoken = await read(
      'add you to our group',
      { coparentGroup: true, coparentGroupMode: 'existing' },
      false,
    );
    expect(spoken.capture.coparentGroupMode).toBe('new');
  });

  it('keeps a no as a no', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const no = await read('no thanks', { coparentGroup: false, coparentGroupMode: 'new' });
    expect(no.capture.coparentGroup).toBe(false);
    expect(no.capture.coparentGroupMode).toBeNull();
  });
});

describe('repairedProse', () => {
  it('folds offered choices into one question and leaves a clean draft alone', () => {
    expect(
      repairedProse(
        'Which of these would help? Baby and Me storytime on Thursdays for Sebastian, or Swim Kids on Saturdays for Mia?',
        'schedule',
      ),
    ).toBe('Baby and Me storytime on Thursdays for Sebastian, or Swim Kids on Saturdays for Mia?');
    expect(
      repairedProse(
        'For Sebastian, how about the storytime Thursdays? For Mia, the Swim Kids class Saturdays? Want reminders for either?',
        'schedule',
      ),
    ).toBe(
      'For Sebastian, how about the storytime Thursdays. For Mia, the Swim Kids class Saturdays. Want reminders for either?',
    );
    expect(repairedProse('Want reminders for the swim?', 'schedule')).toBe('');
    expect(repairedProse('Do you have kids? If so, what are their names?', 'kids_names')).toBe('');
    expect(
      repairedProse(
        `Village Hale Technologies Inc. made Hale, and villagehale.com has the details. ${'It texts you the kids things that fit. '.repeat(3)}What are your kids names?`,
        'kids_names',
      ),
    ).toBe('');
  });

  it('never folds in another step, never repairs a no-question step, and does not cut a long draft', () => {
    expect(
      repairedProse(
        'Want the swim on your calendar? Would a group chat with the other parent help?',
        'schedule',
      ),
    ).toBe('');
    expect(repairedProse('Saw picture day. Want a reminder?', 'connected')).toBe('');
    const long = `${'Gmail helps me catch registration confirmations and activity updates for the kids. '.repeat(2)}Google shares your whole inbox with me, and I keep only what is about the kids. Want to connect?`;
    expect(repairedProse(long, 'email')).toBe('');
    expect(long.length).toBeGreaterThan(220);
  });
});

describe('#868 question marks in any script', () => {
  it('counts the CJK and Arabic question marks as the one ask', () => {
    const base = {
      step: 'place',
      language: 'en',
      address: 'tu',
      introduce: true,
      recentTurns: [],
      placeLabel: null,
      agesLabel: null,
      ageMonths: [],
      findLines: [],
      listKind: 'none',
      activity: null,
      day: null,
      parentName: null,
    } as const;
    expect(
      judgeFriendReply('你好！我是Hale。你住在哪个邮编？', { ...base, parentWords: '你好' }),
    ).toEqual({ ok: true });
    expect(
      judgeFriendReply('مرحبا! أنا Hale. ما هو رمزك البريدي؟', { ...base, parentWords: 'مرحبا' }),
    ).toEqual({ ok: true });
  });
});
