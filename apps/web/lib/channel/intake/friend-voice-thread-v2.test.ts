import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_UNVERIFIED_APP_FACT } from '~/lib/channel/connect/text-connect';
import { loadCronSkill } from '~/lib/cron/skill';
import {
  type FriendVoiceInput,
  friendVoiceContext,
  friendVoiceSystem,
  judgeFriendReply,
  onboardingReplyToolSchema,
  parseReplyTool,
  speakFriend,
  stepAfterCapture,
  tidyProse,
  yesToLink,
} from './friend-voice';
import { FRIEND_VOICE_MODEL_FIELDS_ENABLED_ENV } from './friend-voice-model-fields';
import {
  type OnboardingChecklist,
  ONBOARDING_ORDER,
  THREAD_V2_ORDER,
  acceptOnboardingCapture,
} from './onboarding-turn';
import { THREAD_ONBOARDING_V2_ENABLED_ENV } from './thread-onboarding-v2';

/**
 * VIL-721 · the onboarding friend with THREAD_ONBOARDING_V2_ENABLED dark and lit.
 *
 * Dark, every prompt the model reads (its context, its tool schema, its system prompt)
 * is the shape it was, so recorded evals keep their cache keys. Lit, the walk has the
 * activities item and ONE Google item, the model is handed the unverified-app screen
 * as a fact, and the one-link ask is held to both connectors by the model's own field.
 *
 * A composer here is a fake at the client port that returns a fixed tool value to test
 * the mechanics around it (which field becomes which capture, which draft is refused);
 * it stands in for no judgement a real model makes.
 */

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

const DARK_CHECKLIST: OnboardingChecklist = {
  postal: true,
  kids: true,
  ages: true,
  name: true,
  gmail: false,
  calendar: false,
  schedule: false,
  coparent: false,
};

const LIT_CHECKLIST: OnboardingChecklist = {
  ...DARK_CHECKLIST,
  activities: true,
  google: false,
};

const BOTH = ['gmail', 'calendar'] as const;

function lit() {
  vi.stubEnv(THREAD_ONBOARDING_V2_ENABLED_ENV, 'true');
  // The in-thread walk rides the friend walk.
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dark: the model reads what it read before VIL-721', () => {
  it('keeps the order, the known items and the facts', () => {
    const context = friendVoiceContext(
      blank({ step: 'email', checklist: DARK_CHECKLIST }),
    ) as Record<string, unknown> & { facts: Record<string, unknown> };
    expect(context.order).toEqual([...ONBOARDING_ORDER]);
    expect(context.known).toEqual(DARK_CHECKLIST);
    expect(context.answering).toBe('gmail');
    expect(context.next).toBe('calendar');
    expect(context.facts).not.toHaveProperty('kidActivities');
    expect(context.facts).not.toHaveProperty('googleLink');
  });

  it('keeps the tool schema without any VIL-721 field', () => {
    const schema = onboardingReplyToolSchema({ step: 'email' });
    for (const field of ['activities', 'activitiesNone', 'connectGoogle', 'googleLater']) {
      expect(schema.properties).not.toHaveProperty(field);
    }
  });

  it('keeps the system prompt without the in-thread addendum', async () => {
    const addendum = (await loadCronSkill('onboarding-friend-thread-v2')).instructions;
    const { system, extras } = await friendVoiceSystem({ step: 'email' }, false);
    expect(extras).not.toContain(addendum);
    expect(system).not.toContain(addendum);
  });

  it('drops VIL-721 fields a dark tool value carries, so a dark capture keeps its shape', () => {
    const composed = parseReplyTool({
      reply: 'ok',
      asks: false,
      parentQuestion: false,
      connectorsOffered: [],
      joinPointer: null,
      claimsSaved: false,
      activities: [{ child: 'Maya', activity: 'swim lessons', when: null }],
      connectGoogle: true,
    });
    const capture = acceptOnboardingCapture(composed.capture);
    expect(capture).not.toHaveProperty('activities');
    expect(capture).not.toHaveProperty('connectGoogle');
  });
});

describe('lit: the in-thread walk', () => {
  it('names the lit order and projects what is known onto it', () => {
    lit();
    const context = friendVoiceContext(
      blank({ step: 'google', checklist: LIT_CHECKLIST }),
    ) as Record<string, unknown>;
    expect(context.order).toEqual([...THREAD_V2_ORDER]);
    expect(context.known).toEqual({
      postal: true,
      kids: true,
      ages: true,
      activities: true,
      name: true,
      google: false,
      schedule: false,
      coparent: false,
    });
    expect(context.answering).toBe('google');
    expect(context.next).toBe('schedule');
  });

  it('asks the activities right after the ages', () => {
    lit();
    const context = friendVoiceContext(
      blank({
        step: 'activities',
        checklist: { ...LIT_CHECKLIST, activities: false, name: false },
      }),
    ) as Record<string, unknown>;
    expect(context.answering).toBe('activities');
    expect(context.next).toBe('name');
  });

  it('hands the one-link ask its access lines and the Google screen as facts', () => {
    lit();
    const facts = (
      friendVoiceContext(blank({ step: 'google', checklist: LIT_CHECKLIST })) as {
        facts: Record<string, unknown>;
      }
    ).facts;
    expect(facts.googleLink).toEqual({
      connects: ['Gmail', 'Google Calendar'],
      oneLink: true,
      screen: GOOGLE_UNVERIFIED_APP_FACT,
    });
    const access = facts.access as { true: readonly string[]; untrue: readonly string[] };
    expect(access.true).toContain('Google shares the whole inbox and the whole calendar with Hale');
    expect(access.true).toContain('Hale never sends email');
    expect(access.true).toContain('Hale never changes or deletes their events');
    expect(access.untrue).toContain('it is connected before they tap the link');
  });

  it('hands every turn what the kids already do, and only when lit', () => {
    const kept = [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }];
    lit();
    const facts = (
      friendVoiceContext(blank({ step: 'names', kidActivities: kept })) as {
        facts: Record<string, unknown>;
      }
    ).facts;
    expect(facts.kidActivities).toEqual(kept);
  });

  it('adds the activities and the one-link answer to the tool, and requires none of them', () => {
    lit();
    const schema = onboardingReplyToolSchema({ step: 'activities' });
    for (const field of ['activities', 'activitiesNone', 'connectGoogle', 'googleLater']) {
      expect(schema.properties).toHaveProperty(field);
      expect(schema.required).not.toContain(field);
    }
  });

  it('appends the in-thread addendum to the full prompt and to the retry', async () => {
    lit();
    const addendum = (await loadCronSkill('onboarding-friend-thread-v2')).instructions;
    expect((await friendVoiceSystem({ step: 'google' }, false)).extras).toContain(addendum);
    expect((await friendVoiceSystem({ step: 'google' }, true)).extras).toContain(addendum);
  });

  it('keeps the activities the model read, shape-checked', () => {
    lit();
    const composed = parseReplyTool({
      reply: 'What should I call you?',
      asks: true,
      parentQuestion: false,
      connectorsOffered: [],
      joinPointer: null,
      claimsSaved: false,
      activities: [
        { child: 'Maya', activity: ' swim   lessons ', when: 'Saturdays' },
        { child: null, activity: '123' },
      ],
    });
    expect(acceptOnboardingCapture(composed.capture).activities).toEqual([
      { child: 'Maya', activity: 'swim lessons', when: 'Saturdays' },
    ]);
  });

  it('moves a judged step to the item the capture left open', () => {
    expect(stepAfterCapture('ages', 'activities')).toBe('activities');
    expect(stepAfterCapture('names', 'google')).toBe('google');
  });

  it('reads a yes to the one link as the receipt for that yes, once', () => {
    lit();
    const ask = blank({ step: 'google', checklist: LIT_CHECKLIST });
    const yes = acceptOnboardingCapture({ connectGoogle: true });
    expect(yesToLink(ask, yes)).toBe(true);
    expect(yesToLink({ ...ask, checklist: { ...LIT_CHECKLIST, google: true } }, yes)).toBe(false);
    expect(yesToLink(ask, acceptOnboardingCapture({ connectGoogle: false }))).toBe(false);
  });
});

describe('lit: the judge on the one-link ask', () => {
  const ask = blank({ step: 'google', parentWords: 'Dana', parentName: 'Dana' });
  const prose =
    'Google shows its own "unverified app" screen first: tap Advanced, then continue. Want me to connect Gmail and your calendar with this link?';

  it('passes an ask about both connectors, naming and quoting the screen', () => {
    lit();
    expect(judgeFriendReply(prose, ask, { linkFollows: true, offered: [...BOTH] })).toEqual({
      ok: true,
    });
  });

  it('refuses an ask the model says is about one connector only', () => {
    lit();
    expect(judgeFriendReply(prose, ask, { linkFollows: true, offered: ['gmail'] })).toMatchObject({
      ok: false,
      reason: 'topic',
    });
  });

  it('refuses "this link" when no link rides the message', () => {
    lit();
    expect(judgeFriendReply(prose, ask, { linkFollows: false, offered: [...BOTH] })).toMatchObject({
      ok: false,
      reason: 'link',
    });
  });

  it('refuses saying it is connected before the parent taps', () => {
    lit();
    expect(
      judgeFriendReply('Gmail and your calendar are connected now. Anything else?', ask, {
        linkFollows: true,
        offered: [...BOTH],
      }),
    ).toMatchObject({ ok: false, reason: 'premature' });
  });

  it('grounds an activity the parent gave in an earlier turn', () => {
    lit();
    const names = blank({
      step: 'names',
      parentWords: 'ok',
      kidActivities: [{ child: 'Maya', activity: 'soccer', when: null }],
    });
    expect(judgeFriendReply('Soccer for Maya, got it. What should I call you?', names)).toEqual({
      ok: true,
    });
    expect(
      judgeFriendReply('Soccer for Maya, got it. What should I call you?', {
        ...names,
        kidActivities: [],
      }),
    ).toMatchObject({ ok: false, reason: 'invented' });
  });

  it('keeps both connectors in the one-link receipt when the dark tidier runs', () => {
    lit();
    const receipt = tidyProse(
      'Your inbox and calendar are in. I saw swim on your calendar and a school note in Gmail.',
      blank({ step: 'connected', connector: 'google', parentWords: '' }),
      'connected',
    );
    expect(receipt).toContain('Gmail');
    expect(receipt).toContain('calendar');
  });
});

describe('lit, with the model-fields reading: a yes to the one link', () => {
  const turn = blank({
    step: 'google',
    parentWords: 'sure',
    recentTurns: [{ role: 'hale', body: 'Want me to connect both with one link?', asked: true }],
    checklist: LIT_CHECKLIST,
  });

  function composer(fields: { messageIsYes: boolean; parentQuestion: boolean }) {
    return {
      async compose() {
        return {
          reply: "Great, the link is right there. Tap it when you're ready.",
          capture: {},
          asks: false,
          parentQuestion: fields.parentQuestion,
          connectorsOffered: [...BOTH],
          joinPointer: null,
          claimsSaved: false,
          asksCount: 0,
          asksName: false,
          speaksAsParent: false,
          joinInProse: false,
          messageIsYes: fields.messageIsYes,
          messageOnlyName: null,
          questionBeforeList: false,
        };
      },
    };
  }

  it('is a yes when the model says so and says it is not a question', async () => {
    lit();
    vi.stubEnv(FRIEND_VOICE_MODEL_FIELDS_ENABLED_ENV, 'true');
    const spoken = await speakFriend(
      composer({ messageIsYes: true, parentQuestion: false }),
      turn,
      { linkAbove: true, page: async () => undefined },
    );
    expect(spoken.source).toBe('composed');
    expect(spoken.capture.connectGoogle).toBe(true);
  });

  it('is not a yes when the model marks the message a question', async () => {
    lit();
    vi.stubEnv(FRIEND_VOICE_MODEL_FIELDS_ENABLED_ENV, 'true');
    const spoken = await speakFriend(composer({ messageIsYes: true, parentQuestion: true }), turn, {
      linkAbove: true,
      page: async () => undefined,
    });
    expect(spoken.capture.connectGoogle ?? null).toBeNull();
  });
});
