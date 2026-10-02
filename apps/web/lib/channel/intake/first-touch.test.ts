import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  EMAIL_ASK_BY_LANGUAGE,
  KNOWN_VENUE_HELLO,
  NAMES_ASK_BY_LANGUAGE,
  receiptLine,
} from './cold-start/copy';
import {
  FIRST_TOUCH_AGES_BY_LANGUAGE,
  FIRST_TOUCH_EMPTY_BY_LANGUAGE,
  FIRST_TOUCH_IMESSAGE_BY_LANGUAGE,
  FIRST_TOUCH_SMS_BY_LANGUAGE,
  HALE_GREETING_EN,
  PARENT_CALL_NAME_ASK,
} from './copy';
import type { IntakeCollected } from './extract';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from './fakes';
import { type IntakeDeps, handleInboundSms } from './machine';
import { type ChannelTransport, FakeTransport, type InboundMessage } from './transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const EMPTY: IntakeCollected = { children: [], postalCode: null };
const MAYA: IntakeCollected = {
  children: [
    { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
  ],
  postalCode: 'M5V 2T6',
};

function harness(
  options: {
    extractions?: IntakeCollected[];
    weekFinder?: ActivityFinder | null;
    transport?: ChannelTransport;
  } = {},
): { fake: FakeDb; transport: FakeTransport; deps: IntakeDeps } {
  const fake = makeFakeDb();
  const transport = (options.transport as FakeTransport | undefined) ?? new FakeTransport();
  const deps: IntakeDeps = {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor(options.extractions ?? [EMPTY]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: {
      async compose() {
        return {
          message: 'RADAR',
          itemCount: 0,
          followUpNeeded: false,
          checkpointTold: null,
          weekendPickOffered: false,
          findWon: true,
          firstFindPromised: false,
          actionMove: null,
          actionHeld: 'no_move',
          voiceFallback: null,
        };
      },
    },
    ackComposer: fakeAckComposer,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    seedCivic: async () => 0,
    resolveCenter: async () => ({ lat: 43.6426, lng: -79.3871 }),
    discoveryTrigger: () => {},
    ...(options.weekFinder !== undefined ? { weekFinder: options.weekFinder } : {}),
    now: NOW,
  };
  return {
    fake,
    transport: transport instanceof FakeTransport ? transport : new FakeTransport(),
    deps,
  };
}

function inbound(
  transport: FakeTransport,
  body: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return transport.inbound(PHONE, body, overrides);
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('first touch stays off unless the flag is exactly on', () => {
  it.each(['', 'true', '1', 'ON', 'off'])('keeps the locked greeting for %j', async (value) => {
    if (value) vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', value);
    const { fake, transport, deps } = harness();
    expect(await handleInboundSms(fake.db, inbound(transport, 'hi'), deps)).toEqual({
      status: 'greeted',
    });
    expect(transport.bodies()).toEqual([HALE_GREETING_EN]);
    expect(transport.locationRequests).toEqual([]);
  });
});

describe('first touch ladder', () => {
  beforeEach(() => {
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  });

  it('asks for a postal code on SMS and does not guess from the area code', async () => {
    const { fake, transport, deps } = harness();
    expect(await handleInboundSms(fake.db, inbound(transport, 'hi'), deps)).toEqual({
      status: 'first_touch',
      step: 'place_asked',
    });
    expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.en]);
    expect(transport.locationRequests).toEqual([]);
  });

  it('sends the iMessage sentence and then the location card, and accepts a typed postal', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY] });
    const first = await handleInboundSms(
      fake.db,
      inbound(transport, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(first).toEqual({ status: 'first_touch', step: 'place_asked' });
    expect(transport.bodies()).toEqual([FIRST_TOUCH_IMESSAGE_BY_LANGUAGE.en]);
    expect(transport.locationRequests).toEqual(['chat-1']);

    const typed = await handleInboundSms(
      fake.db,
      inbound(transport, 'M5V 2T6', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(typed).toEqual({ status: 'first_touch', step: 'find_sent' });
    expect(transport.bodies()).toEqual([
      FIRST_TOUCH_IMESSAGE_BY_LANGUAGE.en,
      FIRST_TOUCH_EMPTY_BY_LANGUAGE.en,
      FIRST_TOUCH_AGES_BY_LANGUAGE.en,
    ]);
    expect(transport.locationRequests).toEqual(['chat-1']);
    expect(transport.bodies().join('\n')).not.toContain(FIRST_TOUCH_SMS_BY_LANGUAGE.en);
  });

  it('does not send a second place ask when the card is refused', async () => {
    const transport = new FakeTransport();
    transport.requestLocation = async (input) => {
      transport.locationRequests.push(input.chatId);
      return { status: 'refused', code: '2017' };
    };
    const { fake, deps } = harness({ transport });
    await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(transport.bodies()).toEqual([FIRST_TOUCH_IMESSAGE_BY_LANGUAGE.en]);
    expect(transport.locationRequests).toEqual(['chat-1']);
  });

  it('uses the postal line in a group and does not open a 1:1 location card', async () => {
    const { fake, transport, deps } = harness();
    await handleInboundSms(
      fake.db,
      inbound(transport, 'hi', { transport: 'imessage', chatId: 'chat-group', isGroup: true }),
      deps,
    );
    expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.en]);
    expect(transport.locationRequests).toEqual([]);
  });

  it('skips the place ask when the first text already has a postal code', async () => {
    const { fake, transport, deps } = harness();
    const result = await handleInboundSms(fake.db, inbound(transport, "We're in M5V 2T6"), deps);
    expect(result).toEqual({ status: 'first_touch', step: 'find_sent' });
    expect(transport.bodies()).toEqual([
      FIRST_TOUCH_EMPTY_BY_LANGUAGE.en,
      FIRST_TOUCH_AGES_BY_LANGUAGE.en,
    ]);
  });

  it('sends the empty-find line when the live lookup has nothing', async () => {
    const finder: ActivityFinder = {
      async find() {
        return { found: false, reason: 'no_picks' };
      },
    };
    const { fake, transport, deps } = harness({ weekFinder: finder });
    await handleInboundSms(fake.db, inbound(transport, 'Toronto'), deps);
    expect(transport.bodies()[0]).toBe(FIRST_TOUCH_EMPTY_BY_LANGUAGE.en);
    expect(transport.bodies()[1]).toBe(FIRST_TOUCH_AGES_BY_LANGUAGE.en);
  });

  it('sends a numbered find with no call to action, then the ages ask', async () => {
    const finder: ActivityFinder = {
      async find() {
        return {
          found: true,
          picks: [
            {
              name: 'Storytime',
              ageFit: 'all ages',
              when: 'Saturday',
              price: null,
              sourceName: 'Library',
              source: 'web',
            },
          ],
        };
      },
    };
    const { fake, transport, deps } = harness({ weekFinder: finder });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(transport.bodies()[0]).toBe('1. Storytime (all ages) - Saturday');
    expect(transport.bodies()[0]).not.toMatch(/tap|postal|sign up|book|reserve/i);
    expect(transport.bodies()[1]).toBe(FIRST_TOUCH_AGES_BY_LANGUAGE.en);
  });

  it('speaks French on the place ask, the empty find, and the ages ask', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY] });
    await handleInboundSms(fake.db, inbound(transport, 'Salut'), deps);
    expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.fr]);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(transport.bodies()).toEqual([
      FIRST_TOUCH_SMS_BY_LANGUAGE.fr,
      FIRST_TOUCH_EMPTY_BY_LANGUAGE.fr,
      FIRST_TOUCH_AGES_BY_LANGUAGE.fr,
    ]);
    expect(transport.bodies().join('\n')).not.toContain(PARENT_CALL_NAME_ASK);
  });

  it('sends the age-fit find and the name ask after the ages, and does not repeat the ages ask', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA, EMPTY] });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    const done = await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1'), deps);
    expect(done.status).toBe('provisioned');
    expect(transport.bodies()).toEqual([
      FIRST_TOUCH_SMS_BY_LANGUAGE.en,
      FIRST_TOUCH_EMPTY_BY_LANGUAGE.en,
      FIRST_TOUCH_AGES_BY_LANGUAGE.en,
      'RADAR',
      PARENT_CALL_NAME_ASK,
    ]);

    const waiting = harness({ extractions: [EMPTY, EMPTY, EMPTY] });
    await handleInboundSms(waiting.fake.db, inbound(waiting.transport, 'hi'), waiting.deps);
    await handleInboundSms(waiting.fake.db, inbound(waiting.transport, 'Toronto'), waiting.deps);
    const held = await handleInboundSms(
      waiting.fake.db,
      inbound(waiting.transport, 'not sure'),
      waiting.deps,
    );
    expect(held).toEqual({ status: 'first_touch', step: 'ages_waiting' });
    expect(
      waiting.transport.bodies().filter((body) => body === FIRST_TOUCH_AGES_BY_LANGUAGE.en),
    ).toHaveLength(1);
  });

  it('skips the place ask for a known venue code', async () => {
    const { fake, transport, deps } = harness();
    const result = await handleInboundSms(fake.db, inbound(transport, 'Hi (via markham)'), deps);
    expect(result).toEqual({ status: 'first_touch', step: 'find_sent' });
    expect(transport.bodies()[0]).toBe(KNOWN_VENUE_HELLO.en);
    expect(transport.bodies()[1]).toBe(FIRST_TOUCH_EMPTY_BY_LANGUAGE.en);
    expect(transport.bodies()[2]).toBe(FIRST_TOUCH_AGES_BY_LANGUAGE.en);
    expect(transport.locationRequests).toEqual([]);
    expect(transport.bodies().join('\n')).not.toMatch(/postal code/i);
  });
});

describe('cold-start discovery session', () => {
  beforeEach(() => {
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
  });

  it('sends the receipt and the find, and does not ask for a name', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA] });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    const done = await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1'), deps);
    expect(done.status).toBe('provisioned');
    const receipt = receiptLine([48, 12], 'M5V');
    expect(transport.bodies().at(-1)).toBe(`${receipt}\nRADAR\nReply with the number you want.`);
    expect(transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
    expect(transport.bodies().join('\n')).not.toMatch(/stop|unsubscribe/i);
  });

  it('asks who is taking them after a numbered pick, in one bubble', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA, EMPTY] });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1'), deps);
    const pick = await handleInboundSms(fake.db, inbound(transport, '1'), deps);
    expect(pick.status).toBe('first_touch');
    expect(transport.bodies().at(-1)).toBe("Who's taking them then to that one? I'll note it.");
    expect(transport.bodies().at(-1)?.match(/\?/g)).toHaveLength(1);
    expect(transport.bodies()).not.toContain(PARENT_CALL_NAME_ASK);
  });

  it('sends the locked names line, then calendar, then email on later days', async () => {
    vi.stubEnv('COLD_START_LADDER_COPY_LOCKED', 'true');
    const { fake, transport, deps } = harness({
      extractions: [EMPTY, EMPTY, MAYA, EMPTY, EMPTY, EMPTY, EMPTY],
    });
    const clock = { now: NOW };
    const timed: IntakeDeps = { ...deps, now: NOW };
    Object.defineProperty(timed, 'now', { get: () => clock.now });
    const day = 24 * 60 * 60 * 1000;
    await handleInboundSms(fake.db, inbound(transport, 'hi'), timed);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), timed);
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1'), timed);
    await handleInboundSms(fake.db, inbound(transport, '1'), timed);
    clock.now = new Date(NOW.getTime() + day);
    const names = await handleInboundSms(fake.db, inbound(transport, "I'll take them"), timed);
    expect(names.status).toBe('first_touch');
    expect(transport.bodies().at(-1)).toBe(NAMES_ASK_BY_LANGUAGE.en);
    clock.now = new Date(NOW.getTime() + 2 * day);
    const calendar = await handleInboundSms(
      fake.db,
      inbound(transport, 'she starts daycare in September'),
      timed,
    );
    expect(calendar.status).toBe('first_touch');
    expect(transport.bodies().at(-1)).toBe(
      'Want me to check that one against your calendar? This link is just for you. I can see your events and never change them.',
    );
    clock.now = new Date(NOW.getTime() + 3 * day);
    const email = await handleInboundSms(fake.db, inbound(transport, 'sounds good'), timed);
    expect(email.status).toBe('first_touch');
    expect(transport.bodies().at(-1)).toBe(EMAIL_ASK_BY_LANGUAGE.en);
  });
});
