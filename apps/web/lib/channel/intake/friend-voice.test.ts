import { describe, expect, it } from 'vitest';
import { loadOnboardingFriendShortSkill, loadOnboardingFriendSkill } from '~/lib/cron/skill';
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
    expect(skill.instructions).toContain('ahaMention');
    expect(skill.instructions).toContain('**ack**');
    expect(skill.instructions).toContain('No STOP');
  });

  it('stays lean: state and a playbook, with the gates left to code', async () => {
    const skill = await loadOnboardingFriendSkill();
    const words = skill.instructions.split(/\s+/).filter(Boolean).length;
    const ruleWords = skill.instructions.match(/\b(never|do not|don't|always)\b/gi) ?? [];
    expect(words).toBeLessThan(2400);
    expect(ruleWords.length).toBeLessThan(20);
    expect(skill.instructions).toContain('## What parents need');
    expect(skill.instructions).toContain('## Checked by code');
    expect(skill.instructions).toContain('Registration windows');
    expect(skill.instructions).toContain('Weekly vs one-off');
    // The trust lines are true for a full-read Google scope: no "never sees your mail".
    expect(skill.instructions).not.toMatch(/never sees? your (personal|work) (mail|email)/i);
    expect(skill.instructions).toContain('Do not promise that work or personal mail is never seen');

    // The retry prompt is a skill too, and knows the step it is rewriting.
    const short = await loadOnboardingFriendShortSkill();
    const shortWords = short.instructions.split(/\s+/).filter(Boolean).length;
    expect(shortWords).toBeLessThan(700);
    expect(short.instructions).toContain('**find_show**');
    expect(short.instructions).toContain('**connected**');
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

  it('puts the French find under the model lead, with no question', () => {
    const french = FRIEND_CONVERSATIONS[1]?.turns[3];
    expect(french).toBeDefined();
    if (!french) return;
    const body = fixtureBody(french);
    expect(body).toContain('près');
    expect(body).toContain('1. ');
    expect(body).not.toContain('?');
    expect(body).not.toContain(YEAR_OPEN_LEAD);
    expect(body).not.toContain(YEAR_OPEN_LEAD_FR);
    expect(body).not.toMatch(/\bpres\b|\bage\b|\badapt\b/);
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
  // A list with one question: the legacy numbered find a nudge still sends.
  const swim = blank({
    step: 'nudge_find',
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

  it('answers who-is-this in the model voice, but only when the company is named', () => {
    const asked = blank({
      step: 'kids_names',
      placeLabel: 'Burlington',
      parentWords: 'wait who is this? is this free?',
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
    ).toEqual({ ok: false, reason: 'invented' });
    expect(judgeFriendReply('Your calendar is connected.', input, { ahaMention: null })).toEqual({
      ok: true,
    });
    expect(
      judgeFriendReply('Hockey is on Thursday at 4:00.', input, { ahaMention: 'Hockey' }),
    ).toEqual({ ok: false, reason: 'invented' });
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

  it('sends the real map lines on their own when both openers fail, and still pages', async () => {
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
    expect(spoken.source).toBe('lines');
    expect(spoken.fallback).toBe('model_failed');
    expect(spoken.bubbles).toEqual([
      '1. Swim at the rec centre (ages 3-5) - Saturday',
      '2. Story time (all ages) - Tuesday',
    ]);
    expect(spoken.body).not.toContain('?');
    expect(pages).toHaveLength(1);
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
    ).toEqual({ ok: false, reason: 'invented' });

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
