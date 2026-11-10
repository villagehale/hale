import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadCronSkill,
  loadOnboardingFriendShortSkill,
  loadOnboardingFriendSkill,
} from '~/lib/cron/skill';
import {
  type FriendComposed,
  type FriendVoiceComposer,
  type FriendVoiceInput,
  assembleFriendBody,
  createFriendVoiceComposer,
  friendVoiceContext,
  friendVoiceSystem,
  friendWeekAction,
  judgeFriendReply,
  lastInboundFact,
  nameAskVoiceInput,
  onboardingReplyToolSchema,
  parentReading,
  readGroupLeads,
  speakFriend,
} from './friend-voice';
import { FRIEND_CONVERSATIONS, fixtureBody } from './friend-voice-fixtures';

const EASTERN = 'America/Toronto';

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
  it('hands the household group as its own fact, and leaves the key out when it is not in play (VIL-566)', () => {
    const facts = (input: FriendVoiceInput) =>
      (friendVoiceContext(input) as { facts: Record<string, unknown> }).facts;
    expect(facts(blank({ step: 'ack', householdGroup: 'pending' })).householdGroup).toBe('pending');
    expect(facts(blank({ step: 'ack', householdGroup: 'claimed' })).householdGroup).toBe('claimed');
    expect(facts(blank({ step: 'coparent', householdGroup: 'unclaimed' })).householdGroup).toBe(
      'unclaimed',
    );
    expect(facts(blank({ step: 'ack' }))).not.toHaveProperty('householdGroup');
    expect(facts(blank({ step: 'ack', householdGroup: null }))).not.toHaveProperty(
      'householdGroup',
    );
  });

  it('appends the household-group skill only when the fact rides; other turns keep their bytes (VIL-566)', async () => {
    const base = (await loadOnboardingFriendSkill()).instructions;
    const group = (await loadCronSkill('household-group')).instructions;
    expect((await friendVoiceSystem({ step: 'ack' }, false)).system).toBe(base);
    expect((await friendVoiceSystem({ step: 'ack', householdGroup: null }, false)).system).toBe(
      base,
    );
    expect(
      (await friendVoiceSystem({ step: 'ack', householdGroup: 'pending' }, false)).system,
    ).toBe(`${base}\n\n${group}`);
    const short = (await loadOnboardingFriendShortSkill()).instructions;
    expect((await friendVoiceSystem({ step: 'ack', householdGroup: 'claimed' }, true)).system).toBe(
      `${short}\n\n${group}`,
    );
  });

  it("hands a stored language tag only to Hale's own messages; beside their words it is left out (VIL-538)", () => {
    const stored = { language: 'fr', address: 'tu' as const };
    const answering = friendVoiceContext(
      blank({ step: 'coparent', ...stored, parentWords: 'No calendar for now, thanks' }),
    ) as Record<string, unknown>;
    expect(answering.languageHint).toBeNull();
    expect(answering).not.toHaveProperty('address');

    const own = friendVoiceContext(
      blank({ step: 'connected', ...stored, parentWords: '' }),
    ) as Record<string, unknown>;
    expect(own.languageHint).toBe('fr');
    expect(own.address).toBe('tu');

    // A French group thread still says vous: that is the thread, not a guess at language.
    const group = friendVoiceContext(
      blank({ step: 'coparent', language: 'fr', address: 'vous', parentWords: 'oui' }),
    ) as Record<string, unknown>;
    expect(group.address).toBe('vous');
  });

  it('gives the elapsed time for a several-hours-old text and does not flag a two-minute one', () => {
    // 2:00 p.m. America/Toronto. Five hours earlier is 9:00 a.m., after quiet hours end.
    const now = new Date('2026-08-28T18:00:00.000Z');
    const hoursOld = new Date(now.getTime() - 5 * 3_600_000);
    const brief = friendVoiceContext(
      blank({
        step: 'place',
        introduce: true,
        parentWords: 'hi',
        lastInbound: lastInboundFact(hoursOld, now, EASTERN),
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
        lastInbound: lastInboundFact(new Date(now.getTime() - 2 * 60_000), now, EASTERN),
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
        lastInbound: lastInboundFact(late, morning, EASTERN),
      }),
    );
    expect(pickedUp).toMatchObject({
      lastInbound: { minutesAgo: 8 * 60 + 30, overnight: true, yesterday: true },
    });
  });
});

describe('the open name ask, as the name-capture reader hands it to the model', () => {
  it('carries no Hale turn code wrote, and answers the name ask as a structured fact', () => {
    const input = nameAskVoiceInput('laisse tomber', 'fr', null);
    expect(input.recentTurns).toEqual([]);
    const context = friendVoiceContext(input);
    expect(context).toMatchObject({ answering: 'name', recentTurns: [] });
    expect(JSON.stringify(context)).not.toContain('What should I call you');
  });

  it("uses the family's own language, and none when none is stored", () => {
    expect(nameAskVoiceInput('laisse tomber', 'fr', null).language).toBe('fr');
    expect(nameAskVoiceInput('undo', null, null).language).toBeNull();
  });

  it('logs the kinds and count the judge matched, never the matched draft strings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const problems: string[] = [];
      const spoken = await speakFriend(
        {
          async compose(input) {
            if (input.retry) problems.push(input.retry.problem);
            return {
              reply: 'No problem, see you at swim on Thursday. What should I call you instead?',
              capture: { nameTakenBack: true },
            };
          },
        },
        nameAskVoiceInput('undo', 'en', null),
        { page: async () => {} },
      );
      expect(spoken.source).toBe('unsent');
      // Positive control: the judge matched the draft's words, and only the retry was told.
      expect(problems.join(' ')).toContain('thursday,swim');
      const logged = [...warn.mock.calls, ...error.mock.calls].filter(
        ([, message]) =>
          message === 'onboarding-friend: attempt refused' ||
          message === 'onboarding-friend: unusable reply',
      );
      expect(logged).toHaveLength(2);
      for (const [fields] of logged) {
        expect(fields).toMatchObject({
          reason: 'invented',
          kinds: ['weekday', 'activity'],
          count: 2,
        });
        expect(fields).not.toHaveProperty('detail');
        expect(JSON.stringify(fields)).not.toMatch(/thursday|swim/i);
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
      info.mockRestore();
    }
  });
});

describe('a delayed undo during name capture', () => {
  const asked = blank({
    step: 'names',
    parentWords: 'undo',
    lastInbound: lastInboundFact(
      new Date('2026-08-28T12:00:00.000Z'),
      new Date('2026-08-28T18:00:00.000Z'),
      EASTERN,
    ),
    recentTurns: [{ role: 'hale', body: 'What should I call you?', asked: true }],
    checklist: {
      postal: true,
      kids: true,
      ages: true,
      name: false,
      gmail: false,
      calendar: false,
      schedule: false,
      coparent: false,
    },
  });

  it('does not decide a take-back from the words; a lone name is still a name', () => {
    expect(parentReading(asked)).toBeNull();
    expect(parentReading({ ...asked, parentWords: 'Dana' })).toEqual({
      kind: 'name',
      name: 'Dana',
    });
    expect(friendVoiceContext(asked)).not.toMatchObject({
      reading: { kind: 'undo' },
    });
  });

  // Code-side filter only. The stub is not the model: the skill tells the model
  // a take-back is not a name. This checks that a copied message is dropped
  // when the model already marked the take-back.
  it('does not let a lone capital word override a model take-back', async () => {
    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch school and camp email for the dates?',
            capture: { parentName: null, nameDeclined: true },
          };
        },
      },
      { ...asked, parentWords: 'Undo' },
      { page: async () => undefined },
    );
    expect(spoken.capture.parentName).toBeNull();
    expect(spoken.capture.nameDeclined).toBe(true);
  });

  it('a take-back does not clear a refusal already settled on the capture', async () => {
    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch school and camp email for the dates?',
            capture: { parentName: 'Undo', nameDeclined: true, nameTakenBack: true },
          };
        },
      },
      { ...asked, parentWords: 'Undo' },
      { page: async () => undefined },
    );
    expect(spoken.capture.parentName).toBeNull();
    expect(spoken.capture.nameDeclined).toBe(true);
    expect(spoken.capture.nameTakenBack).toBe(true);
  });

  it('a take-back clears a copied name without closing the name', async () => {
    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch school and camp email for the dates?',
            capture: { parentName: 'Undo', nameTakenBack: true, nameDeclined: false },
          };
        },
      },
      { ...asked, parentWords: 'Undo' },
      { page: async () => undefined },
    );
    expect(spoken.capture.parentName).toBeNull();
    expect(spoken.capture.nameDeclined).toBe(false);
    expect(spoken.capture.nameTakenBack).toBe(true);
  });

  it('drops a parentName that is the whole message once the model marks the take-back', async () => {
    const spoken = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch school and camp email for the dates?',
            capture: { parentName: 'undo', nameDeclined: true },
          };
        },
      },
      asked,
      { page: async () => undefined },
    );
    expect(spoken.capture.parentName).toBeNull();
    expect(spoken.capture.nameDeclined).toBe(true);
  });

  it.each([
    "Got it, I'll call you undo. What should I call you?",
    'Got it, I\'ll call you "undo". What should I call you?',
    'Got it, I’ll call you “undo”. What should I call you?',
    "D'accord. Je t'appelle undo. Qu'est-ce que je surveille ensuite ?",
    'Je t’appelle « undo ». Comment je continue ?',
  ])('refuses a reply that addresses them by the take-back: %s', (reply) => {
    expect(judgeFriendReply(reply, { ...asked, nameTakenBack: true })).toEqual({
      ok: false,
      reason: 'identity',
      detail: 'unknown_name',
      kinds: ['unknown_name'],
    });
  });

  it('does not read an ordinary short answer as a name when a name is already known', () => {
    const named = blank({ ...asked, step: 'email', parentWords: 'sure', parentName: 'Dana' });
    expect(
      judgeFriendReply('Sure thing. Want me to watch school email for the dates?', named),
    ).toEqual({ ok: true });
    expect(judgeFriendReply('Got it. Want me to watch school email, sure?', named)).toEqual({
      ok: true,
    });
  });

  it('checks the draft against any take-back the model marked, whatever its length', () => {
    const long = { ...asked, parentWords: 'actually scratch that for now', nameTakenBack: true };
    expect(
      judgeFriendReply('Okay, "actually scratch that for now" it is. What next?', long),
    ).toEqual({
      ok: false,
      reason: 'identity',
      detail: 'unknown_name',
      kinds: ['unknown_name'],
    });
  });

  it('does not treat the message as a foreign name until the model marks a take-back', () => {
    expect(judgeFriendReply("I'll undo that. What should I call you?", asked)).toEqual({
      ok: true,
    });
  });

  // Code wiring only, with a fake at the composer port: the model's read of
  // "non" is not under test here. This pins that speakFriend hands the judge
  // the model's nameConfirmed false, so the draft check runs.
  it('a turned-down held name: speakFriend refuses a draft that calls them by the message', async () => {
    const drafts = [
      'Got it, I\'ll call you "non". What should I call you?',
      'What should I call you?',
    ];
    const seen: string[] = [];
    const spoken = await speakFriend(
      {
        async compose() {
          const reply = drafts[seen.length] ?? '';
          seen.push(reply);
          return { reply, capture: { parentName: null, nameConfirmed: false } };
        },
      },
      blank({ ...asked, step: 'name_confirm', parentWords: 'non', parentName: 'Bea' }),
      { page: async () => undefined },
    );
    expect(seen).toHaveLength(2);
    expect(spoken.source).not.toBe('unsent');
    expect(spoken.body).toBe('What should I call you?');
  });

  // Code wiring only, with a fake at the composer port.
  it('a one-word name given instead of the held one is kept, and the greeting by it is sent', async () => {
    const seen: string[] = [];
    const spoken = await speakFriend(
      {
        async compose() {
          const reply = 'Got it, Robin. What city are you in?';
          seen.push(reply);
          return { reply, capture: { parentName: 'Robin', nameConfirmed: false } };
        },
      },
      blank({ step: 'name_reply', parentWords: 'Robin', parentName: 'Bea' }),
      { page: async () => undefined },
    );
    expect(seen).toHaveLength(1);
    expect(spoken.body).toBe('Got it, Robin. What city are you in?');
    expect(spoken.capture.parentName).toBe('Robin');
    expect(spoken.capture.nameConfirmed).toBe(false);
  });

  it('asks what to call them after a held name is turned down', () => {
    // speakFriend sets nameTakenBack on the judge input when the model reads nameConfirmed false and no name.
    const confirm = blank({
      ...asked,
      step: 'name_confirm',
      parentWords: 'non',
      parentName: 'Bea',
      nameTakenBack: true,
    });
    expect(judgeFriendReply('What should I call you?', confirm)).toEqual({ ok: true });
    expect(
      judgeFriendReply('Got it, I\'ll call you "non". What should I call you?', confirm),
    ).toEqual({
      ok: false,
      reason: 'identity',
      detail: 'unknown_name',
      kinds: ['unknown_name'],
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
    expect(skill.instructions).toContain('A take-back is not a name');
    expect(skill.instructions).toContain('casual shorthand for letting go');
    expect(skill.instructions).toContain('asks what to call them');
    expect(skill.instructions).not.toContain("I'll call you");
    expect(skill.instructions).not.toContain("Je t'appelle");
  });

  it('stays lean: state and a playbook, with the gates left to code', async () => {
    const skill = await loadOnboardingFriendSkill();
    const words = skill.instructions.split(/\s+/).filter(Boolean).length;
    const ruleWords = skill.instructions.match(/\b(never|do not|don't|always)\b/gi) ?? [];
    expect(words).toBeLessThan(2500);
    expect(skill.instructions).toContain(
      'A take-back is not a name: letting go of what was just said, including casual shorthand for letting go, is not an answer to what to call them.',
    );
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
    expect(short.instructions).toContain('A take-back is not a name');
    expect(short.instructions).toContain('casual shorthand for letting go');
    expect(short.instructions).toContain('nameDeclined` stays false');
    expect(short.instructions).toContain('asks what to call them');
    expect(short.instructions).not.toContain("I'll call you");
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

  it('lets a host through only as a whole word the parent wrote, never a piece of one', () => {
    const yes = blank({ step: 'ack', granted: true, parentWords: 'yes, we use kidsclub.ca' });
    expect(judgeFriendReply('Done. kidsclub.ca it is.', yes)).toEqual({ ok: true });
    expect(judgeFriendReply('Done. club.ca it is.', yes)).toMatchObject({
      ok: false,
      reason: 'invented',
      kinds: ['domain'],
    });
    expect(judgeFriendReply('Done. kidsclub.ca.evil.app it is.', yes)).toMatchObject({
      ok: false,
      reason: 'invented',
      kinds: ['domain'],
    });
  });

  it('reads a link once: a full-width colon or slash in a scheme is still a link', () => {
    const yes = blank({ step: 'ack', granted: true, parentWords: 'yes, we use kidsclub.ca' });
    for (const reply of [
      'Done. https：//evil.app it is.',
      'Done. hxxps：//evil.app/x it is.',
      'Done. https:／／evil.app it is.',
      'Done. https：／／evil.app/x it is.',
    ]) {
      expect(judgeFriendReply(reply, yes), reply).toMatchObject({ ok: false, reason: 'invented' });
    }
    expect(judgeFriendReply('Done. kidsclub.ca it is.', yes)).toEqual({ ok: true });

    const calendar = blank({ step: 'calendar', parentWords: 'Dana', parentName: 'Dana' });
    const link = 'https://app.villagehale.com/connect?t=abc&to=gcal';
    const prose = 'This link is just for you. Want me to check your calendar?';
    expect(judgeFriendReply(`${prose}\n${link}`, calendar, { link })).toEqual({ ok: true });
    expect(
      judgeFriendReply(`${prose}\n${link}\nhttps：//evil.app/x`, calendar, { link }),
    ).toMatchObject({ ok: false, reason: 'invented' });
  });

  it('holds a scheme link to the handed link even when a page or the parent wrote it', () => {
    const listed = blank({
      step: 'ack',
      granted: true,
      parentWords: 'yes, we use kidsclub.ca',
      findLines: ['Swim Tuesdays https://evil.app/x', 'Art Fridays https：//evil.app/y'],
    });
    for (const reply of [
      'Done. Swim Tuesdays, sign up at https://evil.app/x it is.',
      'Done. Art Fridays, sign up at https：//evil.app/y it is.',
      'Done. Swim Tuesdays, sign up at https：//evil.app/x it is.',
    ]) {
      expect(judgeFriendReply(reply, listed), reply).toMatchObject({
        ok: false,
        reason: 'invented',
        kinds: ['domain'],
      });
    }
    const echoed = blank({
      step: 'ack',
      granted: true,
      parentWords: 'yes, sign up at https://evil.app/x',
    });
    expect(judgeFriendReply('Done. https://evil.app/x it is.', echoed)).toMatchObject({
      ok: false,
      reason: 'invented',
      kinds: ['domain'],
    });

    expect(judgeFriendReply('Done. kidsclub.ca it is.', listed)).toEqual({ ok: true });
    expect(judgeFriendReply('Done. See https://villagehale.com for more.', listed)).toEqual({
      ok: true,
    });
    const calendar = blank({ step: 'calendar', parentWords: 'Dana', parentName: 'Dana' });
    const link = 'https://app.villagehale.com/connect?t=abc&to=gcal';
    const prose = 'This link is just for you. Want me to check your calendar?';
    expect(judgeFriendReply(`${prose}\n${link}`, calendar, { link })).toEqual({ ok: true });
  });

  describe('a link may be only the handed link, Hale’s site or the parent’s own words (VIL-632)', () => {
    const synced = (over: { title?: string; location?: string | null; snippet?: string }) =>
      blank({
        step: 'connected',
        connector: over.snippet === undefined ? 'gcal' : 'gmail',
        timeZone: EASTERN,
        synced: {
          provider: over.snippet === undefined ? 'gcal' : 'gmail',
          read: 'ok',
          calendar:
            over.snippet === undefined
              ? [
                  {
                    title: over.title ?? 'Mia swim',
                    start: '2026-10-17T14:00:00.000Z',
                    end: '2026-10-17T14:45:00.000Z',
                    allDay: false,
                    location: over.location ?? null,
                    declined: false,
                  },
                ]
              : [],
          email:
            over.snippet === undefined
              ? []
              : [
                  {
                    subject: 'Picture day',
                    fromName: 'Park Public School',
                    receivedAt: '2026-10-05T14:00:00.000Z',
                    snippet: over.snippet,
                  },
                ],
          overlaps: [],
        },
      });

    it('refuses a link a synced calendar title carries, scheme or bare', () => {
      const input = synced({ title: 'Verify at https://evil.app/login' });
      for (const reply of [
        'Your calendar is in. Saturday: https://evil.app/login',
        'Your calendar is in. Saturday: evil.app/login',
      ]) {
        expect(judgeFriendReply(reply, input), reply).toMatchObject({
          ok: false,
          reason: 'invented',
          kinds: expect.arrayContaining(['domain']),
        });
      }
      const bareTitle = synced({ title: 'Verify at evil.app/login' });
      expect(
        judgeFriendReply('Your calendar is in. Saturday: evil.app/login', bareTitle),
      ).toMatchObject({
        ok: false,
        reason: 'invented',
        kinds: expect.arrayContaining(['domain']),
      });
    });

    it('refuses a link an email snippet carries, scheme or bare', () => {
      for (const snippet of ['Order at https://evil.app/pay', 'Order at evil.app/pay']) {
        const input = synced({ snippet });
        for (const reply of [
          'Your inbox is in. Picture day: https://evil.app/pay',
          'Your inbox is in. Picture day: evil.app/pay',
        ]) {
          expect(judgeFriendReply(reply, input), `${snippet} / ${reply}`).toMatchObject({
            ok: false,
            reason: 'invented',
            kinds: expect.arrayContaining(['domain']),
          });
        }
      }
    });

    it('refuses a link a listing line carries, scheme or bare', () => {
      for (const line of ['Swim Tuesdays https://evil.app/x', 'Swim Tuesdays evil.app/x']) {
        const listed = blank({ step: 'ack', granted: true, parentWords: 'yes', findLines: [line] });
        for (const reply of [
          'Done. Swim Tuesdays, sign up at https://evil.app/x it is.',
          'Done. Swim Tuesdays, sign up at evil.app/x it is.',
        ]) {
          expect(judgeFriendReply(reply, listed), `${line} / ${reply}`).toMatchObject({
            ok: false,
            reason: 'invented',
            kinds: expect.arrayContaining(['domain']),
          });
        }
      }
    });

    it('refuses a link only Hale’s own earlier turn carries', () => {
      const input = blank({
        step: 'ack',
        granted: true,
        parentWords: 'yes',
        recentTurns: [{ role: 'hale', body: 'Swim Tuesdays at evil.app/x' }],
      });
      expect(judgeFriendReply('Done. evil.app/x it is.', input)).toMatchObject({
        ok: false,
        reason: 'invented',
        kinds: expect.arrayContaining(['domain']),
      });
    });

    it('passes the handed link, Hale’s site, and a link the parent typed', () => {
      const calendar = synced({ title: 'Verify at evil.app/login' });
      const link = 'https://app.villagehale.com/connect?t=abc&to=gcal';
      expect(judgeFriendReply(`Your calendar is in.\n${link}`, calendar, { link })).toEqual({
        ok: true,
      });
      expect(judgeFriendReply('Your calendar is in. More at villagehale.com', calendar)).toEqual({
        ok: true,
      });

      const typedNow = blank({ step: 'ack', granted: true, parentWords: 'we use kidsclub.ca' });
      expect(judgeFriendReply('Done. kidsclub.ca it is.', typedNow)).toEqual({ ok: true });
      const typedEarlier = blank({
        step: 'ack',
        granted: true,
        parentWords: 'yes',
        recentTurns: [{ role: 'parent', body: 'we use kidsclub.ca' }],
      });
      expect(judgeFriendReply('Done. kidsclub.ca it is.', typedEarlier)).toEqual({ ok: true });
    });

    it('still grounds a place from a synced slot that holds no link', () => {
      const input = synced({ title: 'Mia swim', location: 'Riverside Pool' });
      expect(
        judgeFriendReply('Your calendar is in. Saturday: Mia swim at Riverside Pool.', input),
      ).toEqual({ ok: true });
    });
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
      timeZone: EASTERN,
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
    const input = blank({
      step: 'connected',
      connector: 'gcal',
      parentWords: '',
      synced,
      timeZone: EASTERN,
    });
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

  it("says a synced time and today on the family's own clock, not Toronto's", () => {
    // 05:30Z on Nov 10 is 11:30 p.m. Nov 9 in Chicago and already Nov 10 in Toronto.
    const now = new Date('2026-11-10T05:30:00.000Z');
    const synced = {
      provider: 'gcal' as const,
      read: 'ok' as const,
      calendar: [
        {
          title: 'Swim at the rec centre',
          // 9:00 a.m. Chicago (CST, UTC-6); 10:00 a.m. in Toronto.
          start: '2026-11-12T15:00:00.000Z',
          end: '2026-11-12T16:00:00.000Z',
          allDay: false,
          location: null,
          declined: false,
        },
      ],
      email: [],
      overlaps: [],
    };
    const input = blank({
      step: 'connected',
      connector: 'gcal',
      parentWords: '',
      synced,
      now,
      timeZone: 'America/Chicago',
    });
    expect(friendVoiceContext(input)).toMatchObject({
      facts: { today: { date: '2026-11-09' }, synced: { calendar: [{ clock: '9:00' }] } },
    });
    expect(
      judgeFriendReply('Swim at the rec centre is Thursday at 9:00.', input, {
        ahaMention: 'Swim at the rec centre',
      }),
    ).toEqual({ ok: true });
    expect(
      judgeFriendReply('Swim at the rec centre is Thursday at 10:00.', input, {
        ahaMention: 'Swim at the rec centre',
      }),
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

  it('keeps a long find_show opener and a long map, and does not page', async () => {
    const pages: string[] = [];
    const opener =
      'I looked near you for what fits this week, and these are the ones that came up from the city pages for their ages, the ones worth a look before the week fills up.';
    expect(opener.length).toBeGreaterThan(120);
    const line = 'Swim at the rec centre (ages 3-5) - Saturday morning at the community pool';
    const lines = Array.from({ length: 24 }, () => line);
    const lead = `A calm one for the younger kid, every Saturday morning:\n${lines.join('\n')}`;
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
    expect(pages).toEqual([]);
    expect(spoken.body).not.toContain('?');
  });

  describe('find_show: every map bubble is one the model wrote (VIL-526)', () => {
    const SWIM_LINE = 'Swim at the rec centre (ages 3-5) - Saturday 10:00';
    const STORY_LINE = 'Story time at the library (all ages) - Tuesday 10:30';
    const OPENER = 'I looked near you for what fits a 4-year-old.';
    const map = blank({
      step: 'find_show',
      parentWords: "she's 4",
      placeLabel: 'M5V',
      ageMonths: [48],
      findLines: [SWIM_LINE, STORY_LINE],
      findGroups: [
        { category: 'swimming', lines: [SWIM_LINE] },
        { category: 'parent_baby', lines: [STORY_LINE] },
      ],
    });
    const SWIM_BUBBLE = 'Swim at the rec centre on Saturday at 10:00, made for ages 3-5.';
    const STORY_BUBBLE = 'Story time at the library, Tuesday at 10:30, any age is welcome.';

    async function speakWith(drafts: (prompt: string) => { reply: string; groupLeads?: unknown }) {
      const prompts: string[] = [];
      const retries: (string | undefined)[] = [];
      const spoken = await speakFriend(
        {
          async compose(given, options) {
            const prompt = options?.prompt ?? 'full';
            prompts.push(prompt);
            retries.push(given.retry?.problem);
            return drafts(prompt) as never;
          },
        },
        map,
        { page: async () => {} },
      );
      return { spoken, prompts, retries };
    }

    it('sends the opener and each group bubble as the model wrote it, with no numbers added', async () => {
      const { spoken } = await speakWith(() => ({
        reply: OPENER,
        groupLeads: [SWIM_BUBBLE, STORY_BUBBLE],
      }));
      expect(spoken.source).toBe('composed');
      expect(spoken.bubbles).toEqual([OPENER, SWIM_BUBBLE, STORY_BUBBLE]);
      expect(spoken.body).not.toMatch(/^\d+\.\s/m);
    });

    it('keeps a group bubble with line breaks as one bubble', async () => {
      const multiline = 'Two swims this week:\nSaturday at 10:00 at the rec centre\nages 3-5';
      const { spoken } = await speakWith(() => ({
        reply: OPENER,
        groupLeads: [multiline, STORY_BUBBLE],
      }));
      expect(spoken.bubbles).toEqual([OPENER, multiline, STORY_BUBBLE]);
    });

    it('refuses a map the model wrote nothing for one group in, and sends the retry that writes every group', async () => {
      const { spoken, prompts, retries } = await speakWith((prompt) =>
        prompt === 'short'
          ? { reply: OPENER, groupLeads: [SWIM_BUBBLE, STORY_BUBBLE] }
          : { reply: OPENER, groupLeads: ['', STORY_BUBBLE] },
      );
      expect(prompts).toEqual(['full', 'short']);
      expect(retries[1]).toMatch(/one bubble per group/);
      expect(spoken.source).toBe('retry');
      expect(spoken.bubbles).toEqual([OPENER, SWIM_BUBBLE, STORY_BUBBLE]);
    });

    it("sends no short map when every attempt borrows another group's time for one bubble", async () => {
      const borrowed = 'Swim at the rec centre on Tuesday at 10:30, made for ages 3-5.';
      const { spoken, prompts } = await speakWith(() => ({
        reply: OPENER,
        groupLeads: [borrowed, STORY_BUBBLE],
      }));
      expect(prompts).toEqual(['full', 'short']);
      expect(spoken).toMatchObject({ source: 'unsent', body: '', bubbles: [] });
    });

    it('asks again when no group bubble survives, and sends the retry that writes them', async () => {
      const { spoken, prompts, retries } = await speakWith((prompt) =>
        prompt === 'short'
          ? { reply: OPENER, groupLeads: [SWIM_BUBBLE, STORY_BUBBLE] }
          : { reply: OPENER, groupLeads: [] },
      );
      expect(prompts).toEqual(['full', 'short']);
      expect(retries[1]).toMatch(/one bubble per group/);
      expect(spoken.source).toBe('retry');
      expect(spoken.bubbles).toEqual([OPENER, SWIM_BUBBLE, STORY_BUBBLE]);
    });

    it('sends nothing at all when neither attempt writes a group bubble', async () => {
      const { spoken, prompts } = await speakWith(() => ({ reply: OPENER, groupLeads: null }));
      expect(prompts).toEqual(['full', 'short']);
      expect(spoken).toMatchObject({ source: 'unsent', body: '', bubbles: [] });
    });

    it('reads a bubble with line breaks as one bubble, in every shape the model returns', () => {
      const multiline = 'Two swims near you:\nSat 10:00\nSun 9:30';
      expect(readGroupLeads([multiline, 'Story time Tue 10:30'])).toEqual([
        multiline,
        'Story time Tue 10:30',
      ]);
      expect(readGroupLeads('a\nb')).toEqual(['a\nb']);
      expect(readGroupLeads({ swimming: { lead: multiline } })).toEqual([multiline]);
      expect(readGroupLeads(JSON.stringify([multiline, 'Story']))).toEqual([multiline, 'Story']);
      expect(readGroupLeads(null)).toBeNull();
    });
  });

  describe('a stop that still asks', () => {
    const later = blank({ step: 'calendar', parentWords: 'later' });
    const CLOSE = 'No worries, I will leave it there.';

    async function speakStop(first: string, second: string, asks?: boolean) {
      const retries: (string | undefined)[] = [];
      const spoken = await speakFriend(
        {
          async compose(given, options) {
            retries.push(given.retry?.problem);
            const retry = options?.prompt === 'short';
            return {
              reply: retry ? second : first,
              ...(asks === undefined || retry ? {} : { asks }),
              capture: { stopAsking: true },
            } as never;
          },
        },
        later,
        { page: async () => {} },
      );
      return { spoken, retries };
    }

    it.each([
      ['a question mark', 'No worries. Want it on your calendar as a weekly reminder?', undefined],
      [
        'a full-width question mark',
        'No worries. Want it on your calendar as a weekly reminder\uFF1F',
        undefined,
      ],
      ['only the asks mark', 'No worries, tell me when you want the calendar.', true],
    ])(
      'asks again when the stop holds %s, and sends the close that asks nothing',
      async (_, draft, asks) => {
        const { spoken, retries } = await speakStop(draft, CLOSE, asks);
        expect(retries[1]).toMatch(/set stopAsking and still asked a question/);
        expect(spoken.source).toBe('retry');
        expect(spoken.body).toBe(CLOSE);
        expect(spoken.capture.stopAsking).toBe(true);
      },
    );

    it('sends nothing and keeps the session open when the retry still asks', async () => {
      const draft = 'No worries. Want it on your calendar as a weekly reminder?';
      const { spoken } = await speakStop(draft, draft);
      expect(spoken).toMatchObject({ source: 'unsent', body: '' });
      expect(spoken.capture.stopAsking).toBe(false);
    });
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
      timeZone: EASTERN,
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
              // Positive control for the save gate: a save this turn really records goes out.
              claimsSaved: true,
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

  describe('a reply never says something was saved that this turn did not save (VIL-538)', () => {
    const coparent = blank({
      step: 'coparent',
      parentWords:
        "No calendar for now. Just save Mia's carpool, tomorrow Saturday 8am, and tell me what day and time you saved.",
      now: new Date('2026-11-02T03:28:00Z'),
      timeZone: EASTERN,
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
    const ASK = 'Would a group chat with the other parent help?';
    const refusedDraft = {
      reply: `Saved Mia's carpool for tomorrow, Saturday at 8. ${ASK}`,
      capture: { scheduleAdds: [{ line: 1, cadence: 'once', date: '2026-11-07', time: '08:00' }] },
      claimsSaved: true,
    };

    it('sends nothing when the retry after a refused add still says it was saved', async () => {
      const pages: string[] = [];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const spoken = await speakFriend(
          {
            async compose(_input, options) {
              if (options?.prompt === 'short') {
                return { reply: `Your carpool request is saved. ${ASK}`, claimsSaved: true };
              }
              return refusedDraft;
            },
          },
          coparent,
          {
            page: async (text) => {
              pages.push(text);
            },
          },
        );
        expect(spoken.source).toBe('unsent');
        expect(spoken.body).toBe('');
        expect(pages).toEqual(['onboarding friend voice unsent step=coparent reason=unusable']);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it('sends the retry that says plainly nothing was saved', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const spoken = await speakFriend(
          {
            async compose(_input, options) {
              if (options?.prompt === 'short') {
                return {
                  reply: `I can't put the carpool on from here, so it isn't saved. ${ASK}`,
                  claimsSaved: false,
                };
              }
              return refusedDraft;
            },
          },
          coparent,
        );
        expect(spoken.source).toBe('retry');
        expect(spoken.body).toContain("isn't saved");
        expect(spoken.capture.scheduleAdds).toEqual([]);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });

    it('refuses a first draft that claims a save with no add at all, and retries', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const prompts: string[] = [];
        const spoken = await speakFriend(
          {
            async compose(_input, options) {
              prompts.push(options?.prompt ?? 'full');
              if (options?.prompt === 'short') {
                return { reply: `That one isn't on your calendar yet. ${ASK}`, claimsSaved: false };
              }
              return {
                reply: `Bien noté, c'est enregistré pour samedi. ${ASK}`,
                claimsSaved: true,
              };
            },
          },
          coparent,
        );
        expect(prompts).toEqual(['full', 'short']);
        expect(spoken.source).toBe('retry');
        expect(warn.mock.calls).toContainEqual([
          expect.objectContaining({ reason: 'unbacked_save', step: 'coparent' }),
          'onboarding-friend: attempt refused',
        ]);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });

    it('refuses a promise no onboarding row can back, the same as the send choke point', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        const prompts: string[] = [];
        const spoken = await speakFriend(
          {
            async compose(_input, options) {
              prompts.push(options?.prompt ?? 'full');
              if (options?.prompt === 'short') return { reply: ASK };
              return { reply: `I'll send an invite to the other parent. ${ASK}` };
            },
          },
          { ...coparent, parentWords: 'maybe' },
        );
        expect(prompts).toEqual(['full', 'short']);
        expect(spoken.body).toBe(ASK);
        expect(warn.mock.calls).toContainEqual([
          expect.objectContaining({ reason: 'unbacked_claim', step: 'coparent' }),
          'onboarding-friend: attempt refused',
        ]);
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });
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

    // The model lists Gmail among what this reply offers. The words are not the check.
    const pivot = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Want me to watch Gmail for the dates too?',
            capture: { connectCalendar: true },
            connectorsOffered: ['gmail'],
          };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(pivot.source).toBe('unsent');
    expect(pivot.body).toBe('');
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
      timeZone: EASTERN,
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
      timeZone: EASTERN,
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
          return {
            reply: 'Great, the number is below for whenever you want.',
            capture,
            joinPointer: 'below' as const,
          };
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

describe('model fields, not text matches', () => {
  const checklist = {
    postal: true,
    kids: true,
    ages: true,
    name: true,
    gmail: false,
    calendar: false,
    schedule: false,
    coparent: false,
  } as const;

  it('reads a yes only when the previous reply said it asked, in any script', () => {
    const gmail = blank({
      step: 'email',
      parentWords: 'oui',
      checklist: { ...checklist, gmail: false },
      recentTurns: [{ role: 'hale', body: '想连接邮箱吗？', asked: true }],
    });
    expect(parentReading(gmail)).toEqual({ kind: 'yes', item: 'gmail' });
    const punctuation = blank({
      ...gmail,
      recentTurns: [{ role: 'hale', body: 'Want me to watch email?' }],
    });
    expect(parentReading(punctuation)).toBeNull();
    const statement = blank({
      ...gmail,
      parentWords: "d'accord",
      recentTurns: [{ role: 'hale', body: 'The number is ready whenever you are.', asked: true }],
    });
    expect(parentReading(statement)).toEqual({ kind: 'yes', item: 'gmail' });
  });

  it('a question is not a yes when the model says so, including with no Latin question mark', async () => {
    const input = blank({
      step: 'calendar',
      parentWords: '你会读我所有的邮件吗',
      checklist: { ...checklist, gmail: true },
    });
    const asked = await speakFriend(
      {
        async compose() {
          return {
            reply:
              'Google shares the whole calendar, and I keep what is about the kids. Want to connect it?',
            capture: { connectCalendar: true },
            parentQuestion: true,
            asks: true,
          };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(asked.source).toBe('composed');
    expect(asked.capture.connectCalendar).toBeNull();
    expect(asked.asks).toBe(true);

    const rhetorical = await speakFriend(
      {
        async compose() {
          return {
            reply: "Great, the link is right there. Tap it and I'll text you what I see.",
            capture: { connectCalendar: true },
            parentQuestion: false,
          };
        },
      },
      blank({ ...input, parentWords: 'yes?' }),
      { page: async () => undefined, linkFollows: true },
    );
    expect(rhetorical.source).toBe('composed');
    expect(rhetorical.capture.connectCalendar).toBe(true);
  });

  it('the other connector comes from what the model says the reply offers, in English and in Chinese', async () => {
    const input = blank({
      step: 'calendar',
      parentWords: 'calendar',
      checklist: { ...checklist, gmail: true },
    });
    const ask = 'The calendar card is the one to tap. Want gmail as well?';
    const english = await speakFriend(
      {
        async compose() {
          return { reply: ask, connectorsOffered: ['calendar'] };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(english.source).toBe('composed');
    expect(english.body).toContain('gmail');

    const chinese = await speakFriend(
      {
        async compose() {
          return { reply: '也要连邮箱吗？', connectorsOffered: ['calendar', 'gmail'] };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(chinese.source).toBe('unsent');
    expect(chinese.body).toBe('');

    const chineseOk = await speakFriend(
      {
        async compose() {
          return { reply: '也要连邮箱吗？', connectorsOffered: [] };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(chineseOk.source).toBe('composed');
    expect(chineseOk.body).toContain('邮箱');
  });

  it('an email ask that also offers the calendar is not sent under the Gmail link', async () => {
    const input = blank({ step: 'email', parentWords: 'yes sure', checklist });
    const reply = 'Tap the link to connect Gmail. Should I connect your calendar too?';
    const offersBoth = await speakFriend(
      {
        async compose() {
          return { reply, connectorsOffered: ['gmail', 'calendar'] };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(offersBoth.source).toBe('unsent');
    expect(offersBoth.body).toBe('');

    const ownOnly = await speakFriend(
      {
        async compose() {
          return { reply, connectorsOffered: ['gmail'] };
        },
      },
      input,
      { page: async () => undefined, linkFollows: true },
    );
    expect(ownOnly.source).toBe('composed');
  });

  it('a co-parent yes points at the number only when joinPointer says so', async () => {
    const input = blank({
      step: 'coparent',
      parentWords: 'oui',
      checklist: { ...checklist, gmail: true, calendar: true, schedule: true, coparent: false },
      coparentJoin: { line: '+1 555-555-0100', phrase: 'this is our year' },
      recentTurns: [{ role: 'hale', body: 'On fait un groupe ?', asked: true }],
    });
    const pointed = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Le numéro est juste en dessous, pour quand tu veux.',
            capture: { coparentGroup: true },
            joinPointer: 'below',
          };
        },
      },
      input,
      { page: async () => undefined },
    );
    expect(pointed.source).toBe('composed');
    expect(pointed.body).toContain('en dessous');

    const wordsOnly = await speakFriend(
      {
        async compose() {
          return {
            reply: 'Add the number below whenever you want.',
            capture: { coparentGroup: true },
          };
        },
      },
      input,
      { page: async () => undefined },
    );
    expect(wordsOnly.source).toBe('unsent');
    expect(wordsOnly.body).toBe('');

    const noEnglishCue = await speakFriend(
      {
        async compose() {
          return {
            reply: '好，按你方便的时候用就行。',
            capture: { coparentGroup: true },
            joinPointer: 'below',
          };
        },
      },
      blank({ ...input, parentWords: '好' }),
      { page: async () => undefined },
    );
    expect(noEnglishCue.source).toBe('composed');
    expect(noEnglishCue.body).toContain('好');
  });

  it('does not rewrite a draft that asks twice, in English or Chinese', async () => {
    const schedule = blank({
      step: 'schedule',
      parentWords: 'maybe',
      findLines: ['Swim Kids on Saturdays'],
      checklist: { ...checklist, gmail: true, calendar: true },
    });
    const english = await speakFriend(
      {
        async compose() {
          return {
            reply:
              'Which of these would help? Baby and Me storytime on Thursdays, or Swim Kids on Saturdays?',
          };
        },
      },
      schedule,
      { page: async () => undefined },
    );
    expect(english.source).toBe('unsent');
    expect(english.body).toBe('');
    expect(english.prose).toBe('');

    const chinese = await speakFriend(
      {
        async compose() {
          return { reply: '哪个适合？周六的游泳怎么样？' };
        },
      },
      schedule,
      { page: async () => undefined },
    );
    expect(chinese.source).toBe('unsent');
    expect(chinese.body).toBe('');
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
      judgeFriendReply('你好！我是Hale，你住在哪个邮编？', { ...base, parentWords: '你好' }),
    ).toEqual({ ok: true });
    // 'Hale。你…' reads as the host 'hale.你…' (fails closed), so the full stop is not used here.
    expect(
      judgeFriendReply('مرحبا! أنا Hale. ما هو رمزك البريدي؟', { ...base, parentWords: 'مرحبا' }),
    ).toEqual({ ok: true });
  });
});

/**
 * VIL-617: a parent who will not give the postal code. On Preview both attempts died
 * with a StructuredOutputError and the log said only that. The recording is the live
 * Haiku reply on the short retry, cut off at its old 600-token budget.
 */
describe('a declined postal code', () => {
  const recorded = JSON.parse(
    readFileSync(join(__dirname, '__recordings__', 'place-decline-truncated.json'), 'utf8'),
  ) as { response: Anthropic.Message };
  const WORDS = "I'd rather not give out my postal code";
  const declined = blank({
    step: 'place',
    parentWords: WORDS,
    recentTurns: [{ role: 'hale', body: 'What is your postal code or ZIP?', asked: true }],
    checklist: {
      postal: false,
      kids: false,
      ages: false,
      name: false,
      gmail: false,
      calendar: false,
      schedule: false,
      coparent: false,
    },
  });

  function toolReply(input: Record<string, unknown>): Anthropic.Message {
    return {
      ...recorded.response,
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'reply', input }],
    } as Anthropic.Message;
  }

  /** Replays the given responses in order, through either transport. */
  function replaying(responses: Anthropic.Message[]) {
    const sent: Array<{ max_tokens: number; messages: Array<{ content: string }> }> = [];
    const next = async (request: unknown) => {
      sent.push(request as (typeof sent)[number]);
      const response = responses.shift();
      if (!response) throw new Error('no recorded response left');
      return response;
    };
    const client = {
      messages: {
        create: next,
        stream: (request: unknown) => ({ finalMessage: () => next(request) }),
      },
    };
    return { sent, composer: createFriendVoiceComposer(client as never) };
  }

  it('logs the structured outcome and stop reason of a cut-off reply, and none of their words', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { composer } = replaying([recorded.response, recorded.response]);
      const spoken = await speakFriend(composer, declined, { page: async () => {} });
      expect(spoken.source).toBe('unsent');
      const compose = [...warn.mock.calls, ...error.mock.calls].filter(
        ([fields]) => (fields as { err?: string } | undefined)?.err === 'StructuredOutputError',
      );
      expect(compose).toHaveLength(2);
      for (const [fields] of compose) {
        expect(fields).toMatchObject({ outcome: 'truncated', stopReason: 'max_tokens' });
        expect(JSON.stringify(fields)).not.toMatch(/postal|rather not/i);
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('gives the retry the room the first attempt had, and lets it carry on without the code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fields = {
        asks: true,
        parentQuestion: false,
        connectorsOffered: [],
        joinPointer: null,
        claimsSaved: false,
      };
      const { sent, composer } = replaying([
        // Two questions: the judge refuses it, so the short retry runs.
        toolReply({ ...fields, reply: 'Totally fair. Just the first part of it? Or your ZIP?' }),
        toolReply({ ...fields, reply: 'Totally fair. How many kids are we looking for?' }),
      ]);
      const spoken = await speakFriend(composer, declined, { page: async () => {} });
      expect(spoken.source).toBe('retry');
      expect(sent).toHaveLength(2);
      // The recorded retry was cut at 600 tokens; the retry gets the first attempt's room.
      expect(sent[1]?.max_tokens).toBe(sent[0]?.max_tokens);
      expect(sent[1]?.max_tokens).toBeGreaterThan(recorded.response.usage.output_tokens);
      const brief = JSON.parse(sent[1]?.messages[0]?.content ?? '{}') as {
        retry?: { problem: string };
      };
      // The retry is not told to ask again for the code they just turned down.
      expect(brief.retry?.problem).toMatch(/declined/);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

/**
 * VIL-617: a consent guard fails closed. In 2 of 42 live draws Haiku wrote tool-call
 * XML into the `parentQuestion` string; a value that is there but is not a boolean
 * may hide a question, so it counts as one. VIL-645: a draw with that markup is now
 * refused where the answer is read, so the short retry writes the reply instead.
 */
describe('a garbled parentQuestion', () => {
  const base = (
    JSON.parse(
      readFileSync(join(__dirname, '__recordings__', 'place-decline-truncated.json'), 'utf8'),
    ) as { response: Anthropic.Message }
  ).response;
  const GARBLED = 'false</parameter>\n<parameter name="connectorsOffered">[]';
  const fields = {
    reply: 'I only keep what is about the kids. Want me to watch for school email?',
    asks: true,
    connectorsOffered: [],
    joinPointer: null,
    claimsSaved: false,
  };

  /** Answers with each input in turn; the last one repeats. */
  function composerReplying(...inputs: Record<string, unknown>[]) {
    const next = async () => {
      const input = inputs.length > 1 ? inputs.shift() : inputs[0];
      return {
        ...base,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_test', name: 'reply', input }],
      } as Anthropic.Message;
    };
    const client = {
      messages: { create: next, stream: () => ({ finalMessage: next }) },
    };
    return createFriendVoiceComposer(client as never);
  }

  const gmailAsk = blank({
    step: 'email',
    parentWords: 'do you read all my emails',
    recentTurns: [{ role: 'hale', body: 'Want me to watch for school email?', asked: true }],
    checklist: {
      postal: true,
      kids: true,
      ages: true,
      name: true,
      gmail: false,
      calendar: false,
      schedule: false,
      coparent: false,
    },
  });

  it('counts a present non-boolean as a question, and an absent one as none', async () => {
    const read = async (input: Record<string, unknown>) =>
      (await composerReplying(input).compose(gmailAsk)).parentQuestion;
    expect(await read({ ...fields, parentQuestion: 'true' })).toBe(true);
    expect(await read(fields)).toBe(false);
    expect(await read({ ...fields, parentQuestion: true })).toBe(true);
    expect(await read({ ...fields, parentQuestion: false })).toBe(false);
  });

  // VIL-617 follow-up: a consent turn the model did not mark keeps no yes.
  it('counts a missing parentQuestion as a question when the turn holds a connect yes', async () => {
    const read = async (input: Record<string, unknown>) =>
      (await composerReplying(input).compose(gmailAsk)).parentQuestion;
    expect(await read({ ...fields, connectGmail: true })).toBe(true);
    expect(await read({ ...fields, connectCalendar: true })).toBe(true);
    // Positive control: with no yes in the turn, a missing value is no question.
    expect(await read({ ...fields, connectGmail: false })).toBe(false);
    expect(await read({ ...fields, connectGmail: true, parentQuestion: false })).toBe(false);
  });

  it('pins parentQuestion: null as a question', async () => {
    const read = async (input: Record<string, unknown>) =>
      (await composerReplying(input).compose(gmailAsk)).parentQuestion;
    expect(await read({ ...fields, parentQuestion: null })).toBe(true);
    expect(await read({ ...fields, parentQuestion: null, connectGmail: false })).toBe(true);
  });

  it('keeps no Gmail yes on a draw that left parentQuestion out', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const unmarked = await speakFriend(
        composerReplying({ ...fields, connectGmail: true }),
        gmailAsk,
        { page: async () => undefined, linkFollows: true },
      );
      expect(unmarked.source).toBe('composed');
      expect(unmarked.capture.connectGmail).not.toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  // VIL-641: a place turned down for good reaches the capture, so code moves on.
  it('passes the model placeDeclined through to the capture', async () => {
    const placeAsk = blank({
      step: 'place',
      parentWords: 'not even that, sorry',
      coarseCodeAsked: true,
      checklist: {
        postal: false,
        kids: false,
        ages: false,
        name: false,
        gmail: false,
        calendar: false,
        schedule: false,
        coparent: false,
      },
    });
    const reply = { ...fields, reply: 'No problem at all. What are your kids called?' };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const declined = await speakFriend(
        composerReplying({ ...reply, parentQuestion: false, placeDeclined: true }),
        placeAsk,
        { page: async () => undefined },
      );
      expect(declined.capture.placeDeclined).toBe(true);
      const open = await speakFriend(
        composerReplying({ ...reply, parentQuestion: false }),
        placeAsk,
        { page: async () => undefined },
      );
      expect(open.capture.placeDeclined).toBe(false);
    } finally {
      info.mockRestore();
    }
  });

  it('refuses a draw with call markup in a field instead of reading it', async () => {
    await expect(
      composerReplying({ ...fields, parentQuestion: GARBLED }).compose(gmailAsk),
    ).rejects.toMatchObject({ outcome: 'tool_markup' });
  });

  it('writes the reply on the retry when the first draw is garbled, and keeps no Gmail yes', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const retried = await speakFriend(
        composerReplying(
          { ...fields, connectGmail: true, parentQuestion: GARBLED },
          { ...fields, parentQuestion: true },
        ),
        gmailAsk,
        { page: async () => undefined, linkFollows: true },
      );
      expect(retried.source).toBe('retry');
      expect(retried.body).toBe(fields.reply);
      expect(retried.capture.connectGmail).not.toBe(true);
      expect(warn.mock.calls).toContainEqual([
        expect.objectContaining({ err: 'StructuredOutputError', outcome: 'tool_markup' }),
        'onboarding-friend: attempt refused',
      ]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('sends nothing when both draws are garbled, and keeps a Gmail yes on a clean one', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const garbled = await speakFriend(
        composerReplying({ ...fields, connectGmail: true, parentQuestion: GARBLED }),
        gmailAsk,
        { page: async () => undefined, linkFollows: true },
      );
      expect(garbled.source).toBe('unsent');
      expect(garbled.capture.connectGmail).not.toBe(true);

      const clean = await speakFriend(
        composerReplying({ ...fields, connectGmail: true, parentQuestion: false }),
        blank({ ...gmailAsk, parentWords: 'sure' }),
        { page: async () => undefined, linkFollows: true },
      );
      expect(clean.source).toBe('composed');
      expect(clean.capture.connectGmail).toBe(true);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

/**
 * VIL-641: the second no to the place is final in code. Code hands the turn the fact
 * that the coarse code was already asked, and a reply that asks for a place once the
 * place is declined is refused and written again, read from the model's `placeAsk`.
 */
describe('a declined place, closed in code', () => {
  const NOTHING_KNOWN = {
    postal: false,
    kids: false,
    ages: false,
    name: false,
    gmail: false,
    calendar: false,
    schedule: false,
    coparent: false,
  };
  const secondNo = blank({
    step: 'place',
    parentWords: 'no, not even that',
    coarseCodeAsked: true,
    checklist: NOTHING_KNOWN,
  });

  function sequenced(drafts: FriendComposed[]) {
    const seen: FriendVoiceInput[] = [];
    const composer: FriendVoiceComposer = {
      async compose(input) {
        seen.push(input);
        const draft = drafts[seen.length - 1];
        if (!draft) throw new Error('no draft left');
        return draft;
      },
    };
    return { composer, seen };
  }
  const draft = (over: Partial<FriendComposed> & { placeDeclined?: boolean }): FriendComposed => {
    const { placeDeclined = false, ...rest } = over;
    return {
      reply: 'No problem at all. What are your kids called?',
      capture: { placeDeclined },
      asks: true,
      parentQuestion: false,
      connectorsOffered: [],
      joinPointer: null,
      claimsSaved: false,
      ...rest,
    };
  };

  it('hands the model the fact that the coarse code was asked, and leaves the key out otherwise', () => {
    const facts = (input: FriendVoiceInput) =>
      (friendVoiceContext(input) as { facts: Record<string, unknown> }).facts;
    expect(facts(secondNo).coarseCodeAsked).toBe(true);
    expect(facts({ ...secondNo, coarseCodeAsked: false })).not.toHaveProperty('coarseCodeAsked');
    expect(facts(blank({ step: 'place' }))).not.toHaveProperty('coarseCodeAsked');
  });

  it('asks for placeAsk and appends the place skill only while the place is in play', async () => {
    const place = (await loadCronSkill('onboarding-friend-place')).instructions;
    const base = (await loadOnboardingFriendSkill()).instructions;
    expect((await friendVoiceSystem(secondNo, false)).system).toBe(`${base}\n\n${place}`);
    expect(
      (await friendVoiceSystem({ step: 'kids_names', placeDeclined: true }, true)).system,
    ).toBe(`${(await loadOnboardingFriendShortSkill()).instructions}\n\n${place}`);
    expect((await friendVoiceSystem({ step: 'email' }, false)).system).toBe(base);
    expect(onboardingReplyToolSchema(secondNo).properties).toHaveProperty('placeAsk');
    expect(onboardingReplyToolSchema(secondNo).required).toContain('placeAsk');
    const email = onboardingReplyToolSchema(blank({ step: 'email' }));
    expect(email.properties).not.toHaveProperty('placeAsk');
    expect(email.required).not.toContain('placeAsk');
  });

  it('refuses a reply that asks for the place after the second no, and sends the rewrite', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { composer, seen } = sequenced([
        draft({
          reply: 'I get it. Would you share just the first three characters?',
          placeDeclined: true,
          placeAsk: 'coarse',
        }),
        draft({ placeAsk: 'none' }),
      ]);
      const sent = await speakFriend(composer, secondNo, { page: async () => undefined });
      expect(seen).toHaveLength(2);
      expect(sent.source).toBe('retry');
      expect(sent.body).toBe('No problem at all. What are your kids called?');
      expect(sent.capture.placeDeclined).toBe(true);
      // The rewrite is written from the walk after the place, with the place closed.
      expect(seen[1]?.step).toBe('kids_names');
      expect(seen[1]?.placeDeclined).toBe(true);
      expect(seen[1]?.retry?.problem).toBeTruthy();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('refuses a rewrite that still asks for the place: nothing is sent', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const asking = draft({
        reply: 'Fair enough. Would a ZIP work instead?',
        placeDeclined: true,
        placeAsk: 'full',
      });
      const { composer, seen } = sequenced([asking, { ...asking, capture: {} }]);
      const sent = await speakFriend(composer, secondNo, { page: async () => undefined });
      expect(seen).toHaveLength(2);
      expect(sent.source).toBe('unsent');
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('sends a closed place that asks for no place, and a first no that asks for the coarse code', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // The field decides, not the words: the same text marked as asking no place goes.
      const closed = sequenced([
        draft({
          reply: 'I get it. Would you share just the first three characters?',
          placeDeclined: true,
          placeAsk: 'none',
        }),
      ]);
      const moved = await speakFriend(closed.composer, secondNo, { page: async () => undefined });
      expect(closed.seen).toHaveLength(1);
      expect(moved.source).toBe('composed');
      expect(moved.capture.placeDeclined).toBe(true);

      const firstNo = sequenced([
        draft({
          reply: 'No problem. Would you share just the first three characters?',
          placeAsk: 'coarse',
        }),
      ]);
      const asked = await speakFriend(
        firstNo.composer,
        { ...secondNo, coarseCodeAsked: undefined, parentWords: "I'd rather not" },
        { page: async () => undefined },
      );
      expect(firstNo.seen).toHaveLength(1);
      expect(asked.source).toBe('composed');
      expect(asked.placeAsk).toBe('coarse');
    } finally {
      info.mockRestore();
    }
  });

  it('keeps the place open on a first no even when the draft marks it declined', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const coarse = 'No problem. Would you share just the first three characters?';
      const marked = () =>
        sequenced([draft({ reply: coarse, placeDeclined: true, placeAsk: 'coarse' })]);
      const first = marked();
      const sent = await speakFriend(
        first.composer,
        { ...secondNo, coarseCodeAsked: undefined, parentWords: "I'd rather not" },
        { page: async () => undefined },
      );
      expect(first.seen).toHaveLength(1);
      expect(sent.source).toBe('composed');
      expect(sent.body).toBe(coarse);
      expect(sent.capture.placeDeclined).toBe(false);

      const closing = sequenced([draft({ placeDeclined: true, placeAsk: 'none' })]);
      const closed = await speakFriend(closing.composer, secondNo, { page: async () => undefined });
      expect(closed.capture.placeDeclined).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('briefs the rewrite of a first no to ask the coarse code, and only a second no to move on', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const twoQuestions = draft({
        reply: 'Totally fair. Could you tell me the city? Or the first three characters?',
        placeAsk: 'coarse',
      });
      const rewriteBrief = async (input: FriendVoiceInput) => {
        const { composer, seen } = sequenced([twoQuestions, draft({ placeAsk: 'coarse' })]);
        await speakFriend(composer, input, { page: async () => undefined });
        expect(seen).toHaveLength(2);
        return seen[1]?.retry?.problem ?? '';
      };
      const firstNo = await rewriteBrief({
        ...secondNo,
        coarseCodeAsked: undefined,
        parentWords: "I'd rather not",
      });
      expect(firstNo).toMatch(/coarse code/);
      expect(firstNo).not.toMatch(/`next`/);
      const second = await rewriteBrief(secondNo);
      expect(second).toMatch(/`next`/);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('reads placeAsk from the tool value, and a value outside the enum as not said', async () => {
    const base = (
      JSON.parse(
        readFileSync(join(__dirname, '__recordings__', 'place-decline-truncated.json'), 'utf8'),
      ) as { response: Anthropic.Message }
    ).response;
    const composerReplying = (input: Record<string, unknown>) => {
      const response = {
        ...base,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_test', name: 'reply', input }],
      } as Anthropic.Message;
      const next = async () => response;
      return createFriendVoiceComposer({
        messages: { create: next, stream: () => ({ finalMessage: next }) },
      } as never);
    };
    const fields = { reply: 'What are your kids called?', asks: true, parentQuestion: false };
    expect(
      (await composerReplying({ ...fields, placeAsk: 'coarse' }).compose(secondNo)).placeAsk,
    ).toBe('coarse');
    expect(
      (await composerReplying({ ...fields, placeAsk: 'town' }).compose(secondNo)).placeAsk,
    ).toBeNull();
  });
});
