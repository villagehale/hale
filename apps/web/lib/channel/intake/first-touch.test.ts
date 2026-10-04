import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { EMERGENCY_REPLY, MENTAL_CRISIS_REPLY } from '~/lib/channel/off-domain/copy';
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
import type { FriendVoiceInput } from './friend-voice';
import { type IntakeDeps, handleInboundSms } from './machine';
import { EMPTY_ONBOARDING_CAPTURE, type OnboardingCapture } from './onboarding-turn';
import { loadOpenSession } from './session';
import { type ChannelTransport, FakeTransport, type InboundMessage } from './transport';
import { YEAR_OPEN_LEAD } from './year-open';

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

function offScriptAside(words: string): string | null {
  if (/what is this/i.test(words)) return "I find what's on for your kids.";
  if (/is this free/i.test(words)) return 'Yes, texting me is free.';
  if (/tell me a joke/i.test(words)) return "I'm not much of a comic.";
  if (/privacy|private/i.test(words))
    return 'I only keep what you send, and you can ask what I have.';
  if (/weather|recipe/i.test(words)) return "That's outside what I do.";
  if (/^(ok|lol|and|thanks)$/i.test(words) || /what's next/i.test(words)) return 'Got it.';
  if (/\b10001\b/.test(words) || /\bchicago\b/i.test(words)) {
    return 'I only cover the Toronto area right now.';
  }
  return null;
}

/** Stand-in for the onboarding model. Production does not parse the message. */
function scriptedTurn(input: FriendVoiceInput): { reply: string; capture: OnboardingCapture } {
  const words = input.parentWords.trim();
  const capture: OnboardingCapture = { ...EMPTY_ONBOARDING_CAPTURE, children: [] };
  const postal = words.match(
    /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])(?:[ -]?(\d[ABCEGHJ-NPRSTV-Z]\d))?\b/i,
  );
  if (postal?.[1]) {
    capture.postalCode = (postal[2] ? `${postal[1]} ${postal[2]}` : postal[1]).toUpperCase();
  }
  const named = [...words.matchAll(/\b([A-Z][a-z]+)\s+is\s+(\d{1,2})\b/g)];
  if (named.length > 0) {
    capture.children = named.map((match) => ({
      name: match[1] ?? null,
      ageMonths: Number(match[2]) * 12,
      agePrecision: 'years' as const,
    }));
  }
  const called = words.match(/\bI'm\s+([A-Z][a-z]+)\b/);
  if (called?.[1]) capture.parentName = called[1];
  if (/^dana$/i.test(words)) capture.parentName = 'Dana';
  if (/^\s*1\s*$/.test(words) || /\bthe first one\b/i.test(words)) capture.activityPick = 1;
  const swimAt = input.findLines.findIndex((line) => /swim/i.test(line));
  if (/\bthe swim one\b/i.test(words) && swimAt >= 0) capture.activityPick = swimAt + 1;
  const actually = words.match(/\bactually\s+(\d{1,2})\b/i);
  if (actually?.[1]) {
    capture.children = [{ name: null, ageMonths: Number(actually[1]) * 12, agePrecision: 'years' }];
  }
  if (/\b10001\b/.test(words)) capture.postalCode = '10001';
  if (/\bchicago\b/i.test(words)) capture.city = 'Chicago';
  if (/\bcheck my calendar\b/i.test(words)) capture.connectCalendar = true;
  if (/^(yes|yeah|yep)$/i.test(words)) {
    if (input.step === 'calendar') capture.connectCalendar = true;
    if (input.step === 'email') capture.connectGmail = true;
  }
  if (/^(no|nope)$/i.test(words)) {
    if (input.step === 'names' || input.step === 'name_confirm') capture.nameDeclined = true;
    if (input.step === 'kids_names') capture.kidsNamesDeclined = true;
    if (input.step === 'calendar') capture.connectCalendar = false;
    if (input.step === 'email') capture.connectGmail = false;
  }
  if (/^later$/i.test(words)) {
    if (input.step === 'names') capture.nameDeclined = true;
    if (input.step === 'calendar') capture.calendarLater = true;
    if (input.step === 'email') capture.gmailLater = true;
  }

  const postalKnown =
    (Boolean(capture.postalCode) && capture.postalCode !== '10001') ||
    Boolean(input.placeLabel) ||
    input.checklist?.postal === true;
  const capturedAges = capture.children.filter((child) => child.ageMonths != null);
  const agesKnown =
    (capture.children.length > 0 &&
      capturedAges.length === capture.children.length &&
      capturedAges.length > 0) ||
    input.ageMonths.length > 0 ||
    input.checklist?.ages === true;
  const pickKnown =
    (capture.activityPick != null && input.findLines.length > 0) ||
    Boolean(input.activity) ||
    input.checklist?.pick === true;
  const nameKnown =
    Boolean(capture.parentName) ||
    capture.nameDeclined ||
    Boolean(input.parentName) ||
    input.checklist?.name === true;
  const calendarKnown =
    capture.connectCalendar != null || capture.calendarLater || input.checklist?.calendar === true;
  const gmailKnown =
    capture.connectGmail != null || capture.gmailLater || input.checklist?.gmail === true;

  let ask: string;
  if (input.language === 'fr' && !postalKnown) {
    ask = "Salut, c'est Hale. Quel est ton code postal?";
  } else if (input.language === 'fr' && !agesKnown) {
    ask = 'Quel âge ont les enfants?';
  } else if (!postalKnown) {
    ask = input.introduce ? "Hey, it's Hale. What's your postal code?" : "What's your postal code?";
  } else if (!agesKnown) {
    ask = 'How old are your kids?';
  } else if (!pickKnown && (input.findLines.length > 0 || input.step === 'find_pick')) {
    ask = 'Which of these looks good?';
  } else if (!nameKnown) {
    ask = 'What should I call you?';
  } else if (input.step === 'kids_names') {
    ask = 'What are their first names?';
  } else if (!calendarKnown) {
    ask = capture.parentName
      ? `${capture.parentName}, want me to check your calendar?`
      : 'Want me to check your calendar?';
  } else if (!gmailKnown) {
    ask = 'Want me to watch school and camp email for the dates?';
  } else if (input.step === 'coparent') {
    ask = "Want the other parent on the kids' year? Text me their number.";
  } else {
    ask = 'Want me to watch school and camp email for the dates?';
  }
  if (input.step === 'help') {
    const missing =
      input.checklist?.postal === false || !input.placeLabel ? 'postal code' : 'next step';
    return {
      reply: `I find what's on for your kids. You're on the ${missing}. Want to keep going?`,
      capture,
    };
  }
  if (input.step === 'nudge_find') {
    return { reply: 'Still here if one of those looks good. Which of these looks good?', capture };
  }
  const aside = offScriptAside(words);
  const reply = aside ? `${aside} ${ask}` : ask;
  return { reply, capture };
}

function harness(
  options: {
    extractions?: IntakeCollected[];
    weekFinder?: ActivityFinder | null;
    transport?: ChannelTransport;
    voice?: boolean;
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
    ...(options.voice
      ? {
          friendVoice: {
            async compose(input: FriendVoiceInput) {
              return scriptedTurn(input);
            },
          },
        }
      : {}),
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
    ).toHaveLength(2);
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
          { is_active: true, phone_number: '+16462352164', first_name: HALE_CONTACT_FIRST_NAME },
          { status: 201 },
        );
      }
      if (target.includes('/contact_card')) {
        return Response.json({
          contact_cards: [
            { phone_number: '+16462352164', first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
          ],
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
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    expect(transport.bodies()).toEqual(["Hey, it's Hale. What's your postal code?"]);
    expect(transport.bodies()[0]).not.toBe(FIRST_TOUCH_SMS_BY_LANGUAGE.en);
    expect(transport.bodies()[0]?.match(/\?/g)).toHaveLength(1);
  });

  it('does not send an empty week find before the ages question', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY], voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(transport.bodies()).toEqual(['How old are your kids?']);
    expect(transport.bodies().join('\n')).not.toContain(FIRST_TOUCH_EMPTY_BY_LANGUAGE.en);
  });

  it('asks what to call you on an empty year find, with no number prompt', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ extractions: [MAYA], voice: true });
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
    const { fake, transport, deps } = harness({ extractions: [MAYA, EMPTY, EMPTY], voice: true });
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
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'Bonjour'), deps);
    const body = transport.bodies()[0] ?? '';
    expect(body).toContain('code postal');
    expect(body).toMatch(/\bton\b/);
    expect(body).not.toMatch(/\bvotre\b/);
    expect(body.match(/\?/g)).toHaveLength(1);
  });

  it('answers each ages miss, including a two-text burst', async () => {
    const { fake, transport, deps } = harness({
      extractions: [EMPTY, EMPTY, EMPTY, EMPTY],
      voice: true,
    });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    const before = transport.bodies().length;
    const and = await handleInboundSms(fake.db, inbound(transport, 'And'), deps);
    const next = await handleInboundSms(fake.db, inbound(transport, "What's next"), deps);
    expect(and).toEqual({ status: 'first_touch', step: 'ages_waiting' });
    expect(next).toEqual({ status: 'first_touch', step: 'ages_waiting' });
    expect(transport.bodies().length).toBe(before + 2);
    expect(transport.bodies().at(-1)).toMatch(/\?/);
    expect(transport.bodies().at(-2)).toMatch(/\?/);
    expect(transport.bodies().join('\n')).not.toContain('How old are the kids?');
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.firstTouch?.clarify?.ages).toBe(2);
  });

  it('answers a place miss instead of going quiet', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY], voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    const held = await handleInboundSms(fake.db, inbound(transport, "And what's next"), deps);
    expect(held).toEqual({ status: 'first_touch', step: 'place_waiting' });
    expect(transport.bodies()).toHaveLength(2);
    expect(transport.bodies()[1]).toMatch(/\?/);
  });

  it('sends nothing canned when the reply cannot be written', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY] });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(transport.bodies()).toEqual([]);
    expect(transport.bodies().join('\n')).not.toContain('How old are the kids?');
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.state).toBe('awaiting_place');
  });

  it('stores a postal code the model extracted even when the words are not a code', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    deps.friendVoice = {
      async compose() {
        return {
          reply: 'Near the lake, got it. How old are your kids?',
          capture: {
            ...EMPTY_ONBOARDING_CAPTURE,
            postalCode: 'M5V 2T6',
          },
        };
      },
    };
    const result = await handleInboundSms(fake.db, inbound(transport, 'the lake one'), deps);
    expect(result).toEqual({ status: 'first_touch', step: 'find_sent' });
    expect(transport.bodies()).toEqual(['Near the lake, got it. How old are your kids?']);
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.firstTouch?.place?.postalCode).toBe('M5V 2T6');
    expect(session?.state).toBe('awaiting_ages');
  });

  it.each([
    ['what is this?', "I find what's on for your kids.", "What's your postal code?"],
    ['is this free?', 'Yes, texting me is free.', "What's your postal code?"],
    ['tell me a joke', "I'm not much of a comic.", "What's your postal code?"],
    ['ok', 'Got it.', "What's your postal code?"],
    ['lol', 'Got it.', "What's your postal code?"],
    ['what about privacy?', 'I only keep what you send', "What's your postal code?"],
    ["what's the weather like?", "That's outside what I do.", "What's your postal code?"],
  ] as const)('answers %j and still asks for a postal code', async (text, answer, ask) => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, text), deps);
    const body = transport.bodies()[0] ?? '';
    expect(body).toContain(answer);
    expect(body.trim().endsWith(ask)).toBe(true);
    expect(body.match(/\?/g)).toHaveLength(1);
    expect((await loadOpenSession(fake.db, PHONE))?.state).toBe('awaiting_place');
  });

  it('answers an ages aside and keeps the age question last', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'is this free?'), deps);
    const body = transport.bodies().at(-1) ?? '';
    expect(body).toContain('Yes, texting me is free.');
    expect(body.trim().endsWith('How old are your kids?')).toBe(true);
    expect((await loadOpenSession(fake.db, PHONE))?.state).toBe('awaiting_ages');
  });

  it('goes straight to the activities when the first text has a postal code and ages', async () => {
    const { fake, transport, deps } = harness({
      voice: true,
      extractions: [EMPTY],
    });
    deps.radar = {
      async compose() {
        return {
          message: '1. Swim (ages 3-5) - Saturday',
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
    };
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const done = await handleInboundSms(
      fake.db,
      inbound(transport, 'Maya is 4 and Leo is 1, M5V 2T6'),
      deps,
    );
    expect(done.status).toBe('provisioned');
    const body = transport.bodies().at(-1) ?? '';
    expect(transport.bodies()).toHaveLength(1);
    expect(body).toContain('1. Swim (ages 3-5) - Saturday');
    expect(body.trim().endsWith('Which of these looks good?')).toBe(true);
    expect(body).not.toMatch(/postal code|how old/i);
  });

  it('keeps a name given out of order and still asks for the postal code first', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, "Maya is 4 and I'm Dana"), deps);
    const body = transport.bodies()[0] ?? '';
    expect(body.trim().endsWith("What's your postal code?")).toBe(true);
    expect(body).not.toMatch(/how old|call you/i);
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.collected.children[0]?.ageMonths).toBe(48);
    expect(session?.firstTouch?.given?.parentName).toBe('Dana');
    expect(session?.state).toBe('awaiting_place');
  });

  it('skips the name after a combined postal, ages, name, and pick, and asks for the calendar', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    deps.radar = {
      async compose() {
        return {
          message: '1. Swim (ages 3-5) - Saturday',
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
    };
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const done = await handleInboundSms(
      fake.db,
      inbound(transport, "Maya is 4 and Leo is 1, M5V 2T6, I'm Dana, the first one. Is this free?"),
      deps,
    );
    expect(done.status).toBe('provisioned');
    const body = transport.bodies().at(-1) ?? '';
    expect(transport.bodies()).toHaveLength(1);
    expect(body).toContain('Yes, texting me is free.');
    expect(body).toMatch(/calendar/i);
    expect(body).toContain('/connect?t=');
    expect(body).not.toMatch(/which of these|call you|postal code|how old/i);
    expect(
      body
        .replace(/https:\/\/\S+/g, '')
        .trim()
        .endsWith('?'),
    ).toBe(true);
  });

  it('answers off-script at the pick, name, and calendar steps and keeps that question last', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    deps.radar = {
      async compose() {
        return {
          message: '1. Swim (ages 3-5) - Saturday',
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
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4 and Leo is 1, M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'tell me a joke'), deps);
    const pick = transport.bodies().at(-1) ?? '';
    expect(pick).toContain("I'm not much of a comic.");
    expect(pick.trim().endsWith('Which of these looks good?')).toBe(true);
    expect(pick).toContain('1. Swim');

    await handleInboundSms(fake.db, inbound(transport, '1'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    const name = transport.bodies().at(-1) ?? '';
    expect(name).toContain('Got it.');
    expect(name.trim().endsWith('What should I call you?')).toBe(true);

    await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
    const calendar = transport.bodies().at(-1) ?? '';
    expect(calendar).toMatch(/calendar/i);
    expect(calendar).toContain('/connect?t=');

    await handleInboundSms(fake.db, inbound(transport, 'lol'), deps);
    const stillCalendar = transport.bodies().at(-1) ?? '';
    expect(stillCalendar).toContain('Got it.');
    expect(stillCalendar).toMatch(/calendar/i);
    expect(stillCalendar).not.toContain('/connect?t=');
    expect(stillCalendar.trim().endsWith('?')).toBe(true);

    await handleInboundSms(fake.db, inbound(transport, 'yes'), deps);
    const gmail = transport.bodies().at(-1) ?? '';
    expect(gmail).toMatch(/email/i);
    expect(gmail).toContain('/connect?t=');
  });

  it('answers a first-text question and sends the safety line before any ask', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    const crisis = await handleInboundSms(fake.db, inbound(transport, 'not breathing'), deps);
    expect(crisis).toEqual({ status: 'first_touch', step: 'place_waiting' });
    expect(transport.bodies()).toEqual([EMERGENCY_REPLY]);
    expect(transport.bodies()[0]).not.toMatch(/postal/i);

    const { fake: fake2, transport: transport2, deps: deps2 } = harness({ voice: true });
    const mental = await handleInboundSms(fake2.db, inbound(transport2, '988'), deps2);
    expect(mental.status).toBe('first_touch');
    expect(transport2.bodies()).toEqual([MENTAL_CRISIS_REPLY]);
  });

  it('always replies on a place miss, including a place outside coverage', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'thanks'), deps);
    expect(transport.bodies().at(-1)).toContain('Got it.');
    expect(transport.bodies().at(-1)?.trim().endsWith("What's your postal code?")).toBe(true);

    await handleInboundSms(fake.db, inbound(transport, '10001'), deps);
    const zip = transport.bodies().at(-1) ?? '';
    expect(zip).toContain('I only cover the Toronto area right now.');
    expect(zip.trim().endsWith("What's your postal code?")).toBe(true);
    expect((await loadOpenSession(fake.db, PHONE))?.state).toBe('awaiting_place');

    await handleInboundSms(fake.db, inbound(transport, 'Chicago'), deps);
    const city = transport.bodies().at(-1) ?? '';
    expect(city).toContain('I only cover the Toronto area right now.');
    expect((await loadOpenSession(fake.db, PHONE))?.firstTouch?.place).toBeNull();
  });

  it('keeps a named child with no age and asks again', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    deps.friendVoice = {
      async compose() {
        return {
          reply: 'Leo still needs an age. How old is Leo?',
          capture: {
            ...EMPTY_ONBOARDING_CAPTURE,
            children: [
              { name: 'Maya', ageMonths: 48, agePrecision: 'years' as const },
              { name: 'Leo', ageMonths: null, agePrecision: null },
            ],
          },
        };
      },
    };
    const held = await handleInboundSms(fake.db, inbound(transport, 'Maya is 4 and Leo'), deps);
    expect(held).toEqual({ status: 'first_touch', step: 'ages_waiting' });
    expect(transport.bodies().at(-1)).toBe('Leo still needs an age. How old is Leo?');
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.collected.children.map((child) => child.name)).toEqual(['Maya', 'Leo']);
    expect(session?.collected.children[1]?.ageMonths).toBeNull();
  });

  it('stores kids names and uses the parent name in the next message', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    deps.radar = {
      async compose() {
        return {
          message: '1. Swim (ages 3-5) - Saturday',
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
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    const kids = fake.rows(schema.children);
    expect(kids.map((row) => row.name)).toEqual(['Maya']);
    expect(transport.bodies().at(-1)).not.toContain(YEAR_OPEN_LEAD);
    await handleInboundSms(fake.db, inbound(transport, '1'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
    expect(transport.bodies().at(-1)).toContain('Dana, want me to check your calendar?');
  });

  it('resolves a word pick against the find lines', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    deps.radar = {
      async compose() {
        return {
          message: '1. Storytime - Tuesday\n2. Swim (ages 3-5) - Saturday',
          itemCount: 2,
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
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'the swim one'), deps);
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.firstTouch?.coldStart?.activity).toMatch(/Swim/);
    expect(transport.bodies().at(-1)).toContain('What should I call you?');
  });

  it('updates the child age and runs the find again', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    let calls = 0;
    deps.radar = {
      async compose() {
        calls += 1;
        return {
          message: calls === 1 ? '1. Storytime - Tuesday' : '1. Swim (ages 5-6) - Saturday',
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
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    const before = fake.rows(schema.children)[0]?.dateOfBirth;
    await handleInboundSms(fake.db, inbound(transport, '1'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'actually 5'), deps);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(fake.rows(schema.children)[0]?.dateOfBirth).not.toBe(before);
    expect(transport.bodies().at(-1)).toContain('Swim (ages 5-6)');
  });

  it('records a no and a later and does not ask that thing again', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    deps.radar = {
      async compose() {
        return {
          message: '1. Swim (ages 3-5) - Saturday',
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
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, '1'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'no'), deps);
    const declined = await loadOpenSession(fake.db, PHONE);
    expect(declined?.firstTouch?.given?.nameDeclined).toBe(true);
    expect(transport.bodies().at(-1)).toMatch(/calendar/i);
    await handleInboundSms(fake.db, inbound(transport, 'later'), deps);
    const later = await loadOpenSession(fake.db, PHONE);
    expect(later?.firstTouch?.given?.calendarLater).toBe(true);
    await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    expect(transport.bodies().at(-1)).toMatch(/email/i);
    expect(transport.bodies().at(-1)).not.toMatch(/calendar/i);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'onboarding_ask_declined',
      ),
    ).toBe(true);
  });

  it('hands a stale cold-start text to the coach instead of the old question', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    deps.radar = {
      async compose() {
        return {
          message: '1. Swim (ages 3-5) - Saturday',
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
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.state).toBe('awaiting_cold_start');
    const staleAt = new Date(NOW.getTime() - 7 * 60 * 60 * 1000).toISOString();
    if (session?.firstTouch) {
      const { saveSession } = await import('./session');
      await saveSession(
        fake.db,
        session,
        {
          transcript: session.transcript.map((entry) => ({ ...entry, at: staleAt })),
        },
        new Date(staleAt),
      );
    }
    const before = transport.bodies().length;
    const stale = await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    expect(stale).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.bodies().length).toBe(before);
    expect(await loadOpenSession(fake.db, PHONE)).toBeNull();
  });

  it('writes HELP from the model when friend voice is on', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'HELP'), deps);
    const body = transport.bodies().at(-1) ?? '';
    expect(body).toContain('postal code');
    expect(body).not.toContain('Reply STOP');
    expect(body.trim().endsWith('?')).toBe(true);
  });

  it('keeps the locked greeting when friend voice is not exactly on', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'true');
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', '');
    const { fake, transport, deps } = harness();
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    expect(transport.bodies()).toEqual([HALE_GREETING_EN]);
  });
});
