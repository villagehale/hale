import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeInboundText } from '~/lib/channel/inbound-route';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from './fakes';
import type { FriendVoiceInput, OfferedConnector } from './friend-voice';
import type { IntakeDeps } from './machine';
import {
  EMPTY_ONBOARDING_CAPTURE,
  type KidActivity,
  type OnboardingCapture,
} from './onboarding-turn';
import { FakeTransport, type InboundMessage } from './transport';

/**
 * VIL-721 · the in-thread onboarding, end to end against the real intake machine, with
 * THREAD_ONBOARDING_V2_ENABLED on (and once off, to show the dark walk is today's).
 *
 * The model is a deterministic stand-in at the composer port: it reads the plain test
 * texts so the walk can be driven, and the tests assert structure (what was sent, how
 * many links, what was stored, when), never its words. Production never parses a
 * parent's message: the real model fills these same fields (no LLM mocking of a
 * judgement: every judge, gate and send below is the production path).
 *
 * The clock moves one minute per parent text, so "first useful info within 10 minutes
 * of the first text" is a number the run records (`intake_completed.duration_s`, the
 * map's own turn), not a claim.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const T0 = new Date('2026-07-30T12:00:00.000Z');
const FROM = '+15555550100';
const FIND_MESSAGE = '1. Swim at the rec centre - Saturday\n2. Story time - Tuesday';
const LINK = /https:\/\/\S+/g;

type WireCapture = Omit<OnboardingCapture, 'parentRole'> & {
  parentRole: 'mother' | 'father' | 'unknown' | null;
  parentRoleBasis: 'stated' | 'guessed' | null;
  activities?: KidActivity[];
  activitiesNone?: boolean;
  connectGoogle?: boolean | null;
};

interface ScriptedTurn {
  reply: string;
  capture: WireCapture;
  groupLeads?: string[];
  asks?: boolean;
  connectorsOffered?: OfferedConnector[];
  joinPointer?: 'below' | 'wrong_owner' | 'placeholder' | 'hale_starts' | 'missing' | null;
}

/**
 * The stand-in for the onboarding model on the v2 walk: postal, kids, ages, the map,
 * the activities, the name, the one Google link, schedule, co-parent.
 */
function v2Turn(input: FriendVoiceInput): ScriptedTurn {
  const words = input.parentWords.trim();
  const capture: WireCapture = {
    ...EMPTY_ONBOARDING_CAPTURE,
    children: [],
    scheduleAdds: [],
    parentRole: null,
    parentRoleBasis: null,
    language: input.language ?? 'en',
  };
  const postal = words.match(/\b([A-Z]\d[A-Z])[ -]?(\d[A-Z]\d)\b/i);
  if (postal?.[1] && postal[2]) capture.postalCode = `${postal[1]} ${postal[2]}`.toUpperCase();
  const bareAge = words.match(/^(?:she|he)(?:'s| is)\s+(\d{1,2})$/i);
  if (bareAge?.[1]) {
    capture.children = [{ name: null, ageMonths: Number(bareAge[1]) * 12, agePrecision: 'years' }];
  }
  if (input.step === 'kids_names' && /^[A-Z][a-z]+$/.test(words)) {
    capture.children = [{ name: words, ageMonths: null, agePrecision: null }];
  }
  if (/^dana$/i.test(words)) {
    capture.parentName = 'Dana';
    capture.parentRole = 'unknown';
    capture.parentRoleBasis = 'guessed';
  }
  // The activities, as the model would read them from the parent's own words.
  if (input.step === 'activities' && /swims/i.test(words)) {
    capture.activities = [{ child: 'Maya', activity: 'swim lessons', when: 'Saturdays' }];
  }
  if (input.step === 'activities' && /^nothing yet$/i.test(words)) capture.activitiesNone = true;
  const yes = /^(yes|yeah|yep)$/i.test(words);
  if (yes && input.step === 'google') capture.connectGoogle = true;
  if (yes && input.step === 'coparent') capture.coparentGroup = true;
  if (yes && input.step === 'schedule' && (input.scheduled ?? []).length === 0) {
    capture.scheduleAdds = [
      { line: 1, cadence: 'weekly', date: '2026-08-01', time: null, weeks: null },
    ];
  }
  if (input.step === 'schedule' && (input.scheduled ?? []).length > 0) capture.scheduleDone = true;
  if (/^(no|nope)$/i.test(words) && input.step === 'google') capture.connectGoogle = false;

  const known = input.checklist;
  const postalKnown = Boolean(capture.postalCode) || Boolean(input.placeLabel) || known?.postal;
  const kidsKnown = capture.children.some((child) => child.name) || known?.kids === true;
  const agesKnown =
    capture.children.some((child) => child.ageMonths != null) ||
    input.ageMonths.length > 0 ||
    known?.ages === true;
  // A dark checklist has no activities or Google item: the dark walk never asks them.
  const activitiesKnown =
    (capture.activities?.length ?? 0) > 0 ||
    capture.activitiesNone === true ||
    known?.activities !== false;
  const nameKnown = Boolean(capture.parentName) || Boolean(input.parentName) || known?.name;
  const googleKnown = capture.connectGoogle != null || known?.google !== false;
  const scheduleKnown = capture.scheduleDone || known?.schedule === true;
  const coparentKnown = capture.coparentGroup != null || known?.coparent === true;
  const who = capture.parentName || input.parentName;

  if (input.step === 'find_show') {
    return {
      reply: 'Here is what is on near you for their ages.',
      capture,
      groupLeads: (input.findGroups ?? []).map((group) => group.lines.join('\n')),
    };
  }
  if (capture.scheduleAdds.length > 0) {
    return { reply: 'Done, a weekly reminder for the first one.', capture };
  }
  if (input.step === 'coparent' && capture.coparentGroup === true) {
    return { reply: 'The number is below whenever you want.', capture, joinPointer: 'below' };
  }
  // The yes to the one link: its receipt, about both, asking nothing.
  if (input.step === 'google' && capture.connectGoogle === true && !known?.google) {
    return {
      reply:
        "Great, the link is right there. Tap it when you're ready and I'll text you what I see.",
      capture,
      connectorsOffered: ['gmail', 'calendar'],
    };
  }
  let ask: string;
  let connectorsOffered: OfferedConnector[] = [];
  if (!postalKnown) ask = "Hey, it's Hale. What's your postal code?";
  else if (!kidsKnown) ask = "What are your kids' names?";
  else if (!agesKnown) ask = 'How old are your kids?';
  else if (!activitiesKnown) ask = 'What do the kids already do, like a class or a sport?';
  else if (!nameKnown) ask = 'What should I call you?';
  else if (!googleKnown) {
    ask = `Google shows its own "unverified app" screen first: tap Advanced, then continue. ${
      who ? `${who}, want` : 'Want'
    } me to connect Gmail and your calendar with one tap?`;
    connectorsOffered = ['gmail', 'calendar'];
  } else if (!scheduleKnown && input.findLines.length > 0) {
    ask = 'Want the first one on your calendar as a weekly reminder?';
  } else if (!coparentKnown) ask = 'Want me to set up a group chat with the other parent?';
  else ask = "I'll take it from here.";
  return { reply: ask, capture, asks: ask.endsWith('?'), connectorsOffered };
}

function findResult() {
  return {
    message: FIND_MESSAGE,
    itemCount: 2,
    followUpNeeded: false,
    checkpointTold: null,
    weekendPickOffered: false,
    findWon: true,
    firstFindPromised: false,
    actionMove: null,
    actionHeld: 'no_move' as const,
    voiceFallback: null,
  };
}

interface Captured {
  event: string;
  properties: Record<string, unknown>;
}

function conversation(compose: (input: FriendVoiceInput) => ScriptedTurn = v2Turn) {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const events: Captured[] = [];
  const seen: FriendVoiceInput[] = [];
  let clock = new Date(T0.getTime() - 60_000);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/contact_card') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          contact_cards: [
            { phone_number: FROM, first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
          ],
        });
      }
      if (target.includes('/contact_card')) {
        return Response.json({
          phone_number: FROM,
          first_name: HALE_CONTACT_FIRST_NAME,
          is_active: true,
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  const deps = (): IntakeDeps => ({
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: { compose: async () => findResult() },
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => clock.getTime()),
    friendVoice: {
      async compose(input: FriendVoiceInput) {
        seen.push(input);
        return compose(input);
      },
    },
    capture: async (event, _distinctId, properties) => {
      events.push({ event, properties: (properties ?? {}) as Record<string, unknown> });
      return 'sent' as const;
    },
    now: clock,
  });
  let sequence = 0;
  return {
    fake,
    transport,
    events,
    seen,
    at: () => clock,
    say: async (body: string) => {
      sequence += 1;
      clock = new Date(clock.getTime() + 60_000);
      vi.setSystemTime(clock);
      const sentFrom = transport.bodies().length;
      const inbound: InboundMessage = {
        from: PHONE,
        body,
        providerId: `v2-${sequence}`,
        receivedAt: clock,
        transport: 'imessage',
        chatId: CHAT,
      };
      const outcome = await routeInboundText(
        {
          database: fake.db,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
          countOutcome: async () => undefined,
          intake: () => ({ ...deps(), now: clock }),
          enqueue: async () => undefined,
          now: () => clock,
        },
        inbound,
      );
      return { bodies: transport.bodies().slice(sentFrom), outcome };
    },
  };
}

function linksIn(bodies: readonly string[]): string[] {
  return bodies.flatMap((body) => body.match(LINK) ?? []);
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('APP_URL', 'https://app.example.com');
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('VIL-721 in-thread onboarding, flag on', () => {
  beforeEach(() => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
  });

  it('walks postal, kids, ages, the map, activities, name, ONE Google link, schedule, co-parent', async () => {
    const talk = conversation();
    expect((await talk.say('hi')).bodies.join('\n')).toMatch(/postal code\?$/);
    expect((await talk.say('M5V 2T6')).bodies.join('\n')).toMatch(/kids' names\?$/);
    expect((await talk.say('Maya')).bodies.join('\n')).toMatch(/How old are your kids\?$/);

    // The map is the first useful thing, and the activities ask follows it on its own.
    const shown = await talk.say("she's 4");
    expect(shown.bodies.length).toBeGreaterThanOrEqual(2);
    expect(shown.bodies.slice(0, -1).join('\n')).toContain('Swim at the rec centre');
    expect(shown.bodies.slice(0, -1).join('\n')).not.toContain('?');
    expect(shown.bodies.at(-1)).toMatch(/already do.*\?$/);

    // First text at T0, the map on the fourth text, three minutes in.
    const completed = talk.events.find((entry) => entry.event === 'intake_completed');
    expect(completed?.properties.duration_s).toBe(180);
    expect(Number(completed?.properties.duration_s)).toBeLessThan(600);

    const named = await talk.say('she swims on Saturdays');
    expect(named.bodies.join('\n')).toMatch(/What should I call you\?$/);

    // One link, for both. No per-provider link, ever.
    const google = await talk.say('Dana');
    const googleText = google.bodies.join('\n');
    expect(googleText.replace(LINK, '')).toMatch(/connect Gmail and your calendar/);
    expect(googleText).toMatch(/unverified app/);
    expect(linksIn(google.bodies)).toHaveLength(1);
    expect(linksIn(google.bodies)[0]).toContain('to=google');

    const yes = await talk.say('yes');
    expect(yes.bodies.join('\n')).toContain('Tap it when');
    expect(yes.bodies.join('\n')).not.toContain('?');
    expect(linksIn(yes.bodies)).toEqual([]);

    expect((await talk.say('ok')).bodies.join('\n')).toMatch(/weekly reminder\?$/);
    expect((await talk.say('yes')).bodies.join('\n')).toBe(
      'Done, a weekly reminder for the first one.',
    );
    expect((await talk.say('sounds good')).bodies.join('\n')).toMatch(/other parent\?$/);

    const all = talk.transport.bodies();
    expect(linksIn(all)).toHaveLength(1);
    expect(all.join('\n')).not.toMatch(/to=gmail|to=gcal/);
    expect(all.join('\n')).not.toMatch(/booked|enrolled|signed up|registered/i);
  });

  it('keeps the activity as family memory with its provenance, and audits counts only', async () => {
    const talk = conversation();
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4", 'she swims on Saturdays']) {
      await talk.say(words);
    }
    const facts = talk.fake.rows(schema.familyMemoryFacts);
    expect(facts).toHaveLength(1);
    const [fact] = facts;
    const [child] = talk.fake.rows(schema.children);
    const [parent] = talk.fake.rows(schema.users);
    expect(fact).toMatchObject({
      childId: child?.id,
      factType: 'routine',
      factKey: 'kid-activity-swim-lessons',
      factValue: {
        schemaVersion: 1,
        kind: 'kid_activity',
        activity: 'swim lessons',
        when: 'Saturdays',
      },
      inferredBy: 'onboarding_thread_v2',
      sourceAudience: 'one_to_one',
      sourceUserId: parent?.id,
      memorySource: 'parent_message',
      memoryKind: 'lasting',
    });
    // The value never carries the kid's name: the row points at the child.
    expect(JSON.stringify(fact?.factValue)).not.toContain('Maya');
    const kept = talk.fake
      .rows(schema.auditLog)
      .filter((row) => row.actionTaken === 'onboarding_activities_kept');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.after).toEqual({ count: 1, linked: 1 });

    // The next turn is handed what was kept, so it is never asked again.
    await talk.say('Dana');
    const next = talk.seen.find((input) => input.parentWords === 'Dana');
    expect(next).toBeDefined();
    expect(next?.kidActivities).toEqual([
      { child: 'Maya', activity: 'swim lessons', when: 'Saturdays' },
    ]);
    expect(next?.checklist?.activities).toBe(true);
  });

  it('takes "nothing yet" as the answer, keeps no fact, and moves to the name', async () => {
    const talk = conversation();
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4"]) await talk.say(words);
    const next = await talk.say('nothing yet');
    expect(next.bodies.join('\n')).toMatch(/What should I call you\?$/);
    expect(talk.fake.rows(schema.familyMemoryFacts)).toEqual([]);
  });

  it('sends nothing on the Google ask when the model offers only one connector, twice', async () => {
    const talk = conversation((input) => {
      const turn = v2Turn(input);
      // A draft about Gmail alone cannot ride the one link: refused, retried, refused.
      return input.step === 'google' ? { ...turn, connectorsOffered: ['gmail'] } : turn;
    });
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4", 'she swims on Saturdays']) {
      await talk.say(words);
    }
    const google = await talk.say('Dana');
    expect(google.bodies).toEqual([]);
    expect(linksIn(talk.transport.bodies())).toEqual([]);
    expect(talk.seen.filter((input) => input.step === 'google')).toHaveLength(2);
  });

  it('hands the model the unverified-app screen as a fact, never as a sentence', async () => {
    const talk = conversation();
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4", 'she swims on Saturdays', 'Dana']) {
      await talk.say(words);
    }
    const ask = talk.seen.find((input) => input.step === 'google');
    expect(ask).toBeDefined();
    expect(ask?.checklist).toMatchObject({ activities: true, name: true, google: false });
  });
});

describe('VIL-721 in-thread onboarding, flag off', () => {
  it("keeps today's walk: the name after the map, then Gmail with its own link", async () => {
    const talk = conversation((input) => {
      const turn = v2Turn(input);
      if (input.step !== 'email') return turn;
      return {
        ...turn,
        reply: 'Want me to watch school and camp email for the dates?',
        connectorsOffered: ['gmail'],
        asks: true,
      };
    });
    for (const words of ['hi', 'M5V 2T6', 'Maya']) await talk.say(words);
    const shown = await talk.say("she's 4");
    expect(shown.bodies.at(-1)).toMatch(/What should I call you\?$/);
    expect(talk.seen.some((input) => input.step === 'activities')).toBe(false);
    const gmail = await talk.say('Dana');
    expect(linksIn(gmail.bodies)).toHaveLength(1);
    expect(linksIn(gmail.bodies)[0]).toContain('to=gmail');
    expect(talk.transport.bodies().join('\n')).not.toContain('to=google');
    // Dark, no turn carries the v2 checklist items or the kept activities.
    expect(talk.seen.every((input) => input.kidActivities === undefined)).toBe(true);
    expect(talk.seen.every((input) => input.checklist?.activities === undefined)).toBe(true);
  });
});
