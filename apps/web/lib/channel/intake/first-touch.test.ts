import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  EMAIL_ASK_BY_LANGUAGE,
  KNOWN_VENUE_HELLO,
  NAMES_ASK_BY_LANGUAGE,
  notedAfterLogistics,
  receiptLine,
  signupOffer,
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
import { loadOpenSession } from './session';
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
    vi.stubEnv('FIRST_TOUCH_LOCATION_CARD_ENABLED', 'true');
    const { fake, transport, deps } = harness();
    expect(await handleInboundSms(fake.db, inbound(transport, 'hi'), deps)).toEqual({
      status: 'first_touch',
      step: 'place_asked',
    });
    expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.en]);
    expect(transport.locationRequests).toEqual([]);
  });

  it('asks for a postal code on iMessage and records the location card as skipped', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA] });
    const first = await handleInboundSms(
      fake.db,
      inbound(transport, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(first).toEqual({ status: 'first_touch', step: 'place_asked' });
    expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.en]);
    expect(transport.locationRequests).toEqual([]);
    expect(transport.bodies()[0]).not.toBe(FIRST_TOUCH_IMESSAGE_BY_LANGUAGE.en);

    await handleInboundSms(
      fake.db,
      inbound(transport, 'M5V 2T6', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    const done = await handleInboundSms(
      fake.db,
      inbound(transport, 'Maya is 4, Leo is 1', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(done.status).toBe('provisioned');
    expect(transport.locationRequests).toEqual([]);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'first_touch_location_requested' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'skipped',
      ),
    ).toBe(true);
  });

  it.each(['on', '1', 'TRUE', 'true\n', ' true '])(
    'keeps the postal sentence on iMessage when the location switch is %j',
    async (value) => {
      vi.stubEnv('FIRST_TOUCH_LOCATION_CARD_ENABLED', value);
      const { fake, transport, deps } = harness();
      await handleInboundSms(
        fake.db,
        inbound(transport, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
        deps,
      );
      expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.en]);
      expect(transport.locationRequests).toEqual([]);
    },
  );

  it('sends the iMessage sentence and then the location card, and accepts a typed postal', async () => {
    vi.stubEnv('FIRST_TOUCH_LOCATION_CARD_ENABLED', 'true');
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY] });
    const order: string[] = [];
    const request = transport.requestLocation.bind(transport);
    transport.requestLocation = async (input) => {
      order.push('location');
      return request(input);
    };
    const send = transport.send.bind(transport);
    transport.send = async (input) => {
      order.push('text');
      return send(input);
    };
    const first = await handleInboundSms(
      fake.db,
      inbound(transport, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(first).toEqual({ status: 'first_touch', step: 'place_asked' });
    expect(order.slice(0, 2)).toEqual(['location', 'text']);
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

  it('asks for a postal code when Linq refuses the location card, and still audits the request', async () => {
    vi.stubEnv('FIRST_TOUCH_LOCATION_CARD_ENABLED', 'true');
    const transport = new FakeTransport();
    const order: string[] = [];
    transport.requestLocation = async (input) => {
      order.push('location');
      transport.locationRequests.push(input.chatId);
      return { status: 'refused', code: '2011' };
    };
    const send = transport.send.bind(transport);
    transport.send = async (input) => {
      order.push('text');
      return send(input);
    };
    const { fake, deps } = harness({ transport, extractions: [EMPTY, EMPTY, MAYA] });
    await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(order.slice(0, 2)).toEqual(['location', 'text']);
    expect(transport.bodies()[0]).toBe(FIRST_TOUCH_SMS_BY_LANGUAGE.en);
    expect(transport.bodies()[0]).not.toBe(FIRST_TOUCH_IMESSAGE_BY_LANGUAGE.en);
    expect(transport.locationRequests).toEqual(['chat-1']);

    await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'M5V 2T6', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    const done = await handleInboundSms(
      fake.db,
      transport.inbound(PHONE, 'Maya is 4, Leo is 1', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(done.status).toBe('provisioned');
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'first_touch_location_requested' &&
          (write.payload.after as { outcome?: string; code?: string } | undefined)?.outcome ===
            'refused' &&
          (write.payload.after as { code?: string } | undefined)?.code === '2011',
      ),
    ).toBe(true);
  });

  it('still sends the place ask when stopping the typing bubble throws', async () => {
    const { fake, transport, deps } = harness();
    const order: string[] = [];
    deps.stopTyping = async () => {
      order.push('stop');
      throw new Error('typing down');
    };
    const send = transport.send.bind(transport);
    transport.send = async (input) => {
      order.push('text');
      return send(input);
    };
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    expect(order[0]).toBe('stop');
    expect(transport.bodies()).toEqual([FIRST_TOUCH_SMS_BY_LANGUAGE.en]);
  });

  it('uses the postal line in a group and does not open a 1:1 location card', async () => {
    vi.stubEnv('FIRST_TOUCH_LOCATION_CARD_ENABLED', 'true');
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

  it.each([
    {
      find: '1. Swim (sign-ups open Sept 8) - Saturday',
      offer: signupOffer('date_known', {
        activity: 'Swim',
        env: { COLD_START_LADDER_COPY_LOCKED: 'true' },
      }).body,
    },
    {
      find: '1. Storytime (all ages) - Saturday',
      offer: signupOffer('no_date', {
        day: 'Saturday',
        env: { COLD_START_LADDER_COPY_LOCKED: 'true' },
      }).body,
    },
  ])(
    'sends the sign-up offer after the name line, then calendar alone ($find)',
    async ({ find, offer }) => {
      vi.stubEnv('COLD_START_LADDER_COPY_LOCKED', 'true');
      const { fake, transport, deps } = harness({
        extractions: [EMPTY, EMPTY, MAYA, EMPTY, EMPTY, EMPTY, EMPTY],
      });
      const timed: IntakeDeps = {
        ...deps,
        now: NOW,
        radar: {
          async compose() {
            return {
              message: find,
              itemCount: 1,
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
      };
      const clock = { now: NOW };
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
      const offered = await handleInboundSms(
        fake.db,
        inbound(transport, 'she starts daycare in September'),
        timed,
      );
      expect(offered.status).toBe('first_touch');
      expect(transport.bodies().at(-1)).toBe(offer);
      expect(transport.bodies().at(-1)).not.toContain('calendar');
      expect(transport.bodies().at(-1)).not.toContain(EMAIL_ASK_BY_LANGUAGE.en);
      clock.now = new Date(NOW.getTime() + 3 * day);
      const calendar = await handleInboundSms(fake.db, inbound(transport, 'sounds good'), timed);
      expect(calendar.status).toBe('first_touch');
      const activity = find.startsWith('1. Swim') ? 'Swim' : 'Storytime';
      expect(transport.bodies().at(-1)).toBe(
        `Want me to check ${activity} against your calendar? This link is just for you. I can see your events and never change them.`,
      );
      expect(transport.bodies().at(-1)).not.toBe(offer);
      expect(transport.bodies().at(-1)).not.toContain(EMAIL_ASK_BY_LANGUAGE.en);
    },
  );

  it('hands a non-answer to the coach once the logistics budget is spent, and does not repeat the note', async () => {
    vi.stubEnv('COLD_START_LADDER_COPY_LOCKED', 'true');
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA, EMPTY, EMPTY] });
    const note = notedAfterLogistics(false, 'en');
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1'), deps);
    await handleInboundSms(fake.db, inbound(transport, '1'), deps);
    const ok = await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    expect(ok).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.bodies()).not.toContain(note);
    const chinese = await handleInboundSms(fake.db, inbound(transport, '你好，周末有什么'), deps);
    expect(chinese).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.bodies().filter((body) => body === note)).toEqual([]);
  });

  function linqCardFetch(abortSetups: number) {
    let setups = 0;
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (target.includes('share_contact_card')) {
        return new Response(null, { status: 200 });
      }
      if (target.includes('/contact_card') && method === 'POST') {
        setups += 1;
        if (setups <= abortSetups) {
          const abort = new Error('The operation was aborted');
          abort.name = 'AbortError';
          throw abort;
        }
        return Response.json(
          { is_active: true, phone_number: '+16462352164', first_name: 'Hale' },
          { status: 201 },
        );
      }
      if (target.includes('/contact_card')) {
        return Response.json({
          contact_cards: [{ phone_number: '+16462352164', first_name: 'Hale', is_active: true }],
        });
      }
      if (target.includes('/messages')) {
        return Response.json({ message: { id: 'msg-out' } }, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
  }

  function shareCalls(fetchMock: { mock: { calls: unknown[][] } }) {
    return fetchMock.mock.calls.filter((call) => String(call[0]).includes('share_contact_card'));
  }

  it('retries a timed-out Name and Photo setup once in the same hello', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    vi.stubEnv('COLD_START_LADDER_COPY_LOCKED', 'true');
    const fetchMock = linqCardFetch(1);
    vi.stubGlobal('fetch', fetchMock);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA, EMPTY, EMPTY] });
    const imessage = { transport: 'imessage' as const, chatId: 'chat-1' };
    await handleInboundSms(fake.db, inbound(transport, 'hi', imessage), deps);
    expect(shareCalls(fetchMock)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(
      { familyId: null, outcome: 'shared' },
      'linq contact card: shared',
    );
    expect((await loadOpenSession(fake.db, PHONE))?.linqContactCardClaim?.outcome).toBe('shared');

    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6', imessage), deps);
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1', imessage), deps);
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
    expect(shareCalls(fetchMock)).toHaveLength(1);
    await handleInboundSms(fake.db, inbound(transport, '1', imessage), deps);
    expect(shareCalls(fetchMock)).toHaveLength(1);
    info.mockRestore();
    vi.unstubAllGlobals();
  });

  it('records a setup timeout on the session and shares on the next outbound', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    vi.stubEnv('COLD_START_LADDER_COPY_LOCKED', 'true');
    const fetchMock = linqCardFetch(2);
    vi.stubGlobal('fetch', fetchMock);
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA, EMPTY, EMPTY] });
    const imessage = { transport: 'imessage' as const, chatId: 'chat-1' };
    await handleInboundSms(fake.db, inbound(transport, 'hi', imessage), deps);
    expect(shareCalls(fetchMock)).toHaveLength(0);
    expect((await loadOpenSession(fake.db, PHONE))?.linqContactCardClaim).toMatchObject({
      outcome: 'unreachable',
      code: 'unreachable',
      attempts: 1,
    });

    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6', imessage), deps);
    expect(shareCalls(fetchMock)).toHaveLength(1);
    expect((await loadOpenSession(fake.db, PHONE))?.linqContactCardClaim?.outcome).toBe('shared');

    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, Leo is 1', imessage), deps);
    expect(fake.rows(schema.parentChannels)[0]?.linqContactCardSharedAt).toEqual(NOW);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'linq_contact_card_shared' &&
          (write.payload.after as { outcome?: string } | undefined)?.outcome === 'shared',
      ),
    ).toBe(true);
    await handleInboundSms(fake.db, inbound(transport, '1', imessage), deps);
    expect(shareCalls(fetchMock)).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe('friend voice onboarding', () => {
  beforeEach(() => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  });

  it('asks for a postal code in one question, not the locked sentence', async () => {
    const { fake, transport, deps } = harness();
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    expect(transport.bodies()).toEqual(["Hey, it's Hale. What's your postal code?"]);
    expect(transport.bodies()[0]).not.toBe(FIRST_TOUCH_SMS_BY_LANGUAGE.en);
    expect(transport.bodies()[0]?.match(/\?/g)).toHaveLength(1);
  });

  it('does not send an empty week find before the ages question', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY] });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(transport.bodies()).toEqual(['How old are the kids?']);
    expect(transport.bodies().join('\n')).not.toContain(FIRST_TOUCH_EMPTY_BY_LANGUAGE.en);
  });

  it('asks what to call you on an empty year find, with no number prompt', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ extractions: [MAYA] });
    const done = await handleInboundSms(
      fake.db,
      inbound(transport, 'Maya is 4 and Leo is 1, M5V 2T6'),
      deps,
    );
    expect(done.status).toBe('provisioned');
    const last = transport.bodies().at(-1) ?? '';
    expect(transport.bodies()).toHaveLength(1);
    expect(last).toContain('What should I call you?');
    expect(last).not.toContain('Reply with the number you want.');
    expect(last).not.toContain(FIRST_TOUCH_EMPTY_BY_LANGUAGE.en);
    expect(last.match(/\?/g)).toHaveLength(1);
  });

  it('moves from a numbered find to the name, then a calendar link', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ extractions: [MAYA, EMPTY, EMPTY] });
    const timed: IntakeDeps = {
      ...deps,
      radar: {
        async compose() {
          return {
            message:
              "Here's what's on for your kids this year:\n1. Swim (ages 3-5) - Saturdays 10am - $12",
            itemCount: 1,
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
    };
    const opened = await handleInboundSms(
      fake.db,
      inbound(transport, 'Maya is 4 and Leo is 1, we are in M5V 2T6'),
      timed,
    );
    expect(opened.status).toBe('provisioned');
    const find = transport.bodies().at(-1) ?? '';
    expect(find).toContain('Which of these looks good?');
    expect(find).toContain('Swim (ages 3-5) - Saturdays 10am - $12');
    expect(find).not.toContain('Reply with the number you want.');
    expect(find.match(/\?/g)).toHaveLength(1);

    const picked = await handleInboundSms(fake.db, inbound(transport, '1'), timed);
    expect(picked.status).toBe('first_touch');
    const nameAsk = transport.bodies().at(-1) ?? '';
    expect(nameAsk).toContain('What should I call you?');
    expect(nameAsk).not.toMatch(/I'll note it/i);
    expect(nameAsk.match(/\?/g)).toHaveLength(1);

    const named = await handleInboundSms(fake.db, inbound(transport, 'Dana'), timed);
    expect(named.status).toBe('first_touch');
    const calendar = transport.bodies().at(-1) ?? '';
    expect(calendar).toContain('/connect?t=');
    expect(calendar).toMatch(/calendar/i);
    expect(calendar).not.toMatch(/I'll note it/i);
    expect(calendar.replace(/https:\/\/\S+/g, '').match(/\?/g)).toHaveLength(1);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'parent_name_captured',
      ),
    ).toBe(true);
  });

  it('answers a French hello in tu, with one question', async () => {
    const { fake, transport, deps } = harness();
    await handleInboundSms(fake.db, inbound(transport, 'Bonjour'), deps);
    const body = transport.bodies()[0] ?? '';
    expect(body).toContain('code postal');
    expect(body).toMatch(/\bton\b/);
    expect(body).not.toMatch(/\bvotre\b/);
    expect(body.match(/\?/g)).toHaveLength(1);
  });

  it('keeps the locked greeting when friend voice is not exactly on', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'true');
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', '');
    const { fake, transport, deps } = harness();
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    expect(transport.bodies()).toEqual([HALE_GREETING_EN]);
  });
});
