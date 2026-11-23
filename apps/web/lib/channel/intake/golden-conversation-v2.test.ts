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
import type { FriendVoiceInput } from './friend-voice';
import { type ScriptedTurn, findResult, v2Turn } from './golden-conversation-v2.fixture';
import type { IntakeDeps } from './machine';
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
const LINK = /https:\/\/\S+/g;

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
  // Pinned, not assumed: the flags-on CI job turns every default-off flag on, and this
  // stand-in does not fill the marks the model-fields flag would require.
  vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');
  vi.stubEnv('FRIEND_VOICE_MODEL_FIELDS_ENABLED', 'false');
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

  it('hands the next turn what the parent said the kids do, so it is never asked again', async () => {
    const talk = conversation();
    for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4", 'she swims on Saturdays']) {
      await talk.say(words);
    }
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
