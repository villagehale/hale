import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleUnverifiedAppLine } from '~/lib/channel/connect/text-connect';
import { routeInboundText } from '~/lib/channel/inbound-route';
import {
  HALE_CONTACT_FIRST_NAME,
  LINQ_CARD_REPLY_BUDGET_MS,
} from '~/lib/channel/linq/contact-card';
import { LINQ_TYPING_REFRESH_MS } from '~/lib/channel/linq/presence';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { DISCOVERY_NEXT_STEP, KNOWN_VENUE_HELLO } from './cold-start/copy';
import {
  COLD_START_ASK,
  FIRST_TOUCH_AGES_BY_LANGUAGE,
  FIRST_TOUCH_EMPTY_BY_LANGUAGE,
  FIRST_TOUCH_GROUP_FR,
  FIRST_TOUCH_IMESSAGE_BY_LANGUAGE,
  FIRST_TOUCH_SMS_BY_LANGUAGE,
  HALE_GREETING_EN,
  HELP_REPLY,
  SITTING_SESSION_REMINDER,
} from './copy';
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
import { FakeTransport, type InboundMessage } from './transport';
import { YEAR_OPEN_LEAD, YEAR_OPEN_LEAD_FR } from './year-open';

/**
 * End-to-end onboarding conversations against the real intake machine.
 * The model and the activity search are deterministic stand-ins.
 * Changes under apps/web/lib/channel/intake have to keep this file green.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const FROM = '+15555550100';
const FIND_MESSAGE = '1. Swim at the rec centre - Saturday\n2. Story time - Tuesday';

const CANNED = [
  FIRST_TOUCH_SMS_BY_LANGUAGE.en,
  FIRST_TOUCH_SMS_BY_LANGUAGE.fr,
  FIRST_TOUCH_IMESSAGE_BY_LANGUAGE.en,
  FIRST_TOUCH_AGES_BY_LANGUAGE.en,
  FIRST_TOUCH_AGES_BY_LANGUAGE.fr,
  FIRST_TOUCH_EMPTY_BY_LANGUAGE.en,
  FIRST_TOUCH_EMPTY_BY_LANGUAGE.fr,
  FIRST_TOUCH_GROUP_FR,
  HALE_GREETING_EN,
  COLD_START_ASK,
  SITTING_SESSION_REMINDER,
  YEAR_OPEN_LEAD,
  YEAR_OPEN_LEAD_FR,
  KNOWN_VENUE_HELLO.en,
  DISCOVERY_NEXT_STEP.en,
  DISCOVERY_NEXT_STEP.fr,
  HELP_REPLY,
  googleUnverifiedAppLine('en'),
];

type Mark = 'typing-start' | 'typing-stop' | 'send' | 'card' | 'search';

function offScriptAside(words: string): string | null {
  if (/what is this/i.test(words)) return "I find what's on for your kids.";
  if (/is this free/i.test(words)) return 'Yes, texting me is free.';
  if (/tell me a joke/i.test(words)) return "I'm not much of a comic.";
  if (/privacy|private/i.test(words))
    return 'I only keep what you send, and you can ask what I have.';
  if (/weather|recipe/i.test(words)) return "That's outside what I do.";
  if (/^(ok|lol|and|thanks)$/i.test(words) || /what's next/i.test(words)) return 'Got it.';
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
  const bareAge = words.match(/\b(?:she|he)(?:'s| is)\s+(\d{1,2})\b/i);
  if (bareAge?.[1] && capture.children.length === 0) {
    capture.children = [{ name: null, ageMonths: Number(bareAge[1]) * 12, agePrecision: 'years' }];
  }
  const called = words.match(/\bI'm\s+([A-Z][a-z]+)\b/);
  if (called?.[1]) capture.parentName = called[1];
  if (/^dana$/i.test(words)) capture.parentName = 'Dana';
  if (input.step === 'kids_names' && /^[A-Z][a-z]+$/.test(words)) {
    const age = input.ageMonths[0] ?? null;
    capture.children = [
      { name: words, ageMonths: age, agePrecision: age == null ? null : 'years' },
    ];
  }
  if (
    /^\s*1\s*$/.test(words) ||
    /\bthe first one\b/i.test(words) ||
    /\bthe swim one\b/i.test(words)
  ) {
    const swimAt = input.findLines.findIndex((line) => /swim/i.test(line));
    capture.activityPick = swimAt >= 0 ? swimAt + 1 : 1;
  }
  if (/\bcheck my calendar\b/i.test(words)) capture.connectCalendar = true;
  if (/^(yes|yeah|yep)$/i.test(words)) {
    if (input.step === 'calendar') capture.connectCalendar = true;
    if (input.step === 'email') capture.connectGmail = true;
  }

  const postalKnown =
    Boolean(capture.postalCode) || Boolean(input.placeLabel) || input.checklist?.postal === true;
  const capturedAges = capture.children.filter((child) => child.ageMonths != null);
  const agesKnown =
    (capture.children.length > 0 && capturedAges.length === capture.children.length) ||
    input.ageMonths.length > 0 ||
    input.checklist?.ages === true;
  const pickKnown =
    capture.activityPick != null || Boolean(input.activity) || input.checklist?.pick === true;
  const nameKnown =
    Boolean(capture.parentName) || Boolean(input.parentName) || input.checklist?.name === true;
  const kidsKnown =
    (capture.children.length > 0 && capture.children.every((child) => Boolean(child.name))) ||
    input.checklist?.kids === true;
  const calendarKnown = capture.connectCalendar != null || input.checklist?.calendar === true;
  const gmailKnown = capture.connectGmail != null || input.checklist?.gmail === true;
  const who = capture.parentName || input.parentName;

  let ask: string;
  if (!postalKnown) ask = "Hey, it's Hale. What's your postal code?";
  else if (!agesKnown) ask = 'How old are your kids?';
  else if (!pickKnown) ask = 'Which of these looks good?';
  else if (!nameKnown) ask = 'What should I call you?';
  else if (!kidsKnown) ask = 'What are their first names?';
  else if (!calendarKnown) {
    ask = who ? `${who}, want me to check your calendar?` : 'Want me to check your calendar?';
  } else if (!gmailKnown) ask = 'Want me to watch school and camp email for the dates?';
  else ask = "I'll take it from here.";

  const aside = offScriptAside(words);
  const reply = aside ? `${aside} ${ask}` : ask;
  return { reply, capture };
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

function expectNoCanned(bodies: string[]) {
  const blob = bodies.join('\n');
  for (const line of CANNED) {
    expect(blob, line).not.toContain(line);
  }
}

function assertTypingUntilSend(turn: Mark[]) {
  const sendAt = turn.indexOf('send');
  expect(sendAt).toBeGreaterThan(0);
  const before = turn.slice(0, sendAt);
  expect(before).toContain('typing-start');
  const stopAt = before.lastIndexOf('typing-stop');
  if (stopAt >= 0) expect(before.slice(stopAt + 1)).toEqual([]);
  expect(before.filter((mark) => mark === 'typing-start').length).toBeGreaterThanOrEqual(2);
  const cardAt = turn.indexOf('card');
  if (cardAt >= 0) expect(cardAt).toBeGreaterThan(sendAt);
}

interface Conversation {
  fake: FakeDb;
  transport: FakeTransport;
  deps: IntakeDeps;
  marks: Mark[];
  cardNames: string[];
  say: (body: string) => Promise<{ bodies: string[]; outcome: string; marks: Mark[] }>;
}

function conversation(options?: {
  compose?: FriendVoiceInput extends never
    ? never
    : (input: FriendVoiceInput) => {
        reply: string;
        capture: OnboardingCapture;
      };
  search?: () => Promise<ReturnType<typeof findResult>>;
}): Conversation {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const marks: Mark[] = [];
  const cardNames: string[] = [];
  const send = transport.send.bind(transport);
  transport.send = async (input) => {
    marks.push('send');
    return send(input);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.includes('/typing')) {
        marks.push(method === 'DELETE' ? 'typing-stop' : 'typing-start');
        return new Response(null, { status: 204 });
      }
      if (target.includes('share_contact_card')) {
        return new Response(null, { status: 200 });
      }
      if (target.includes('/contact_card')) {
        marks.push('card');
        if (method === 'GET') {
          return Response.json({
            contact_cards: [
              { phone_number: FROM, first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
            ],
          });
        }
        const payload = init?.body
          ? (JSON.parse(String(init.body)) as { first_name?: string })
          : {};
        if (payload.first_name) cardNames.push(payload.first_name);
        return Response.json({
          phone_number: FROM,
          first_name: payload.first_name ?? HALE_CONTACT_FIRST_NAME,
          is_active: true,
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  let sequence = 0;
  const deps: IntakeDeps = {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: {
      async compose() {
        marks.push('search');
        if (options?.search) return options.search();
        return findResult();
      },
    },
    ackComposer: fakeAckComposer,
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    seedCivic: async () => 0,
    resolveCenter: async () => ({ lat: 43.6426, lng: -79.3871 }),
    discoveryTrigger: () => {},
    friendVoice: {
      async compose(input: FriendVoiceInput) {
        return (options?.compose ?? scriptedTurn)(input);
      },
    },
    now: NOW,
  };
  return {
    fake,
    transport,
    deps,
    marks,
    cardNames,
    say: async (body: string) => {
      sequence += 1;
      const from = marks.length;
      const sentFrom = transport.bodies().length;
      const inbound: InboundMessage = {
        from: PHONE,
        body,
        providerId: `golden-${sequence}-${body.length}`,
        receivedAt: NOW,
        transport: 'imessage',
        chatId: CHAT,
      };
      const outcome = await routeInboundText(
        {
          database: fake.db,
          log: { info: () => undefined, warn: () => undefined, error: () => undefined },
          countOutcome: async () => undefined,
          intake: () => deps,
          enqueue: async () => undefined,
          now: () => NOW,
        },
        inbound,
        0,
      );
      return {
        bodies: transport.bodies().slice(sentFrom),
        outcome,
        marks: marks.slice(from),
      };
    },
  };
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', FROM);
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('golden onboarding conversation', () => {
  it('walks postal, ages, activities, pick, names, calendar, Gmail, then chat', async () => {
    const talk = conversation();
    const postal = await talk.say('hi');
    expect(postal.bodies.join('\n')).toMatch(/postal code\?$/);
    assertTypingUntilSend(postal.marks);

    const ages = await talk.say('M5V 2T6');
    expect(ages.bodies.join('\n')).toMatch(/How old are your kids\?$/);
    expect(ages.bodies.join('\n')).not.toMatch(/Swim/);
    assertTypingUntilSend(ages.marks);

    const activities = await talk.say("she's 4");
    const listed = activities.bodies.join('\n');
    expect(listed).toContain('1. Swim at the rec centre');
    expect(listed).toMatch(/Which of these looks good\?$/);
    assertTypingUntilSend(activities.marks);

    const pick = await talk.say('the swim one');
    expect(pick.bodies.join('\n')).toMatch(/What should I call you\?$/);
    assertTypingUntilSend(pick.marks);

    const parent = await talk.say('Dana');
    expect(parent.bodies.join('\n')).toMatch(/What are their first names\?$/);
    assertTypingUntilSend(parent.marks);

    const kids = await talk.say('Maya');
    expect(kids.bodies.join('\n').replace(/\nhttps:\/\/\S+/g, '')).toMatch(
      /Dana, want me to check your calendar\?$/,
    );
    expect(kids.bodies.join('\n')).toMatch(/https:\/\//);
    assertTypingUntilSend(kids.marks);

    const calendar = await talk.say('yes');
    expect(calendar.bodies.join('\n')).toMatch(/email/i);
    assertTypingUntilSend(calendar.marks);

    const gmail = await talk.say('yes');
    expect(gmail.bodies.join('\n').trim().length).toBeGreaterThan(0);
    expect(gmail.outcome).toBe('intake');

    const chat = await talk.say('Maya loved the pool');
    expect(chat.outcome).toBe('handed_off');
    expect(chat.bodies).toEqual([]);
    expect(chat.marks).toContain('typing-start');
    expectNoCanned(talk.transport.bodies());
  });

  it('takes postal, ages, a pick, a name, and calendar from the first message', async () => {
    const talk = conversation();
    const first = await talk.say("M5V 2T6, Maya is 4, I'm Dana, the swim one, check my calendar");
    const body = first.bodies.join('\n');
    expect(body).toMatch(/email/i);
    expect(body).not.toMatch(/postal code/i);
    expect(body).not.toMatch(/How old/);
    expect(body).not.toMatch(/Which of these/);
    expect(body).not.toMatch(/What should I call you/);
    expect(first.bodies.length).toBeGreaterThan(0);
    assertTypingUntilSend(first.marks);
    expectNoCanned(talk.transport.bodies());
  });

  it('takes two items from one message and asks the next missing one', async () => {
    const talk = conversation();
    const first = await talk.say('M5V 2T6, Maya is 4');
    const body = first.bodies.join('\n');
    expect(body).toContain('1. Swim at the rec centre');
    expect(body).toMatch(/Which of these looks good\?$/);
    expect(body).not.toMatch(/How old/);
    expect(body).not.toMatch(/postal code\?$/);
    assertTypingUntilSend(first.marks);
    expectNoCanned(talk.transport.bodies());
  });

  it('answers off-script at every step and still asks the current question', async () => {
    const talk = conversation();
    const steps: { text: string; aside: string; question: RegExp }[] = [
      {
        text: 'what is this?',
        aside: "I find what's on for your kids.",
        question: /postal code\?$/,
      },
      { text: 'is this free?', aside: 'Yes, texting me is free.', question: /postal code\?$/ },
    ];
    for (const step of steps) {
      const turn = await talk.say(step.text);
      const body = turn.bodies.join('\n');
      expect(body).toContain(step.aside);
      expect(body).toMatch(step.question);
      expect(turn.bodies.length).toBeGreaterThan(0);
      assertTypingUntilSend(turn.marks);
    }
    await talk.say('M5V 2T6');
    const ages = await talk.say('is this free?');
    expect(ages.bodies.join('\n')).toContain('Yes, texting me is free.');
    expect(ages.bodies.join('\n')).toMatch(/How old are your kids\?$/);

    await talk.say("she's 4");
    const pick = await talk.say('tell me a joke');
    expect(pick.bodies.join('\n')).toContain("I'm not much of a comic.");
    expect(pick.bodies.join('\n')).toMatch(/Which of these looks good\?$/);

    await talk.say('the swim one');
    const name = await talk.say('is this private?');
    expect(name.bodies.join('\n')).toContain('I only keep what you send');
    expect(name.bodies.join('\n')).toMatch(/What should I call you\?$/);

    await talk.say('Dana');
    const kids = await talk.say('what is the weather?');
    expect(kids.bodies.join('\n')).toContain("That's outside what I do.");
    expect(kids.bodies.join('\n')).toMatch(/What are their first names\?$/);

    await talk.say('Maya');
    const calendar = await talk.say('lol');
    expect(calendar.bodies.join('\n')).toContain('Got it.');
    expect(calendar.bodies.join('\n')).toMatch(/calendar\?$/);

    await talk.say('yes');
    const email = await talk.say('ok');
    expect(email.bodies.join('\n')).toContain('Got it.');
    expect(email.bodies.join('\n')).toMatch(/email/i);
    expect(talk.transport.bodies().every((body) => body.trim().length > 0)).toBe(true);
    expectNoCanned(talk.transport.bodies());
  });

  it('replies to each message in a burst', async () => {
    const talk = conversation();
    const first = await talk.say('And');
    const second = await talk.say("What's next");
    expect(first.bodies.join('\n')).toContain('Got it.');
    expect(first.bodies.join('\n')).toMatch(/postal code\?$/);
    expect(second.bodies.join('\n')).toContain('Got it.');
    expect(second.bodies.join('\n')).toMatch(/postal code\?$/);
    expect(first.bodies.length).toBeGreaterThan(0);
    expect(second.bodies.length).toBeGreaterThan(0);
    assertTypingUntilSend(first.marks);
    assertTypingUntilSend(second.marks);
    expectNoCanned(talk.transport.bodies());
  });

  it('shares the contact card as Hale plus hibiscus after the reply', async () => {
    const talk = conversation();
    const first = await talk.say('hi');
    expect(HALE_CONTACT_FIRST_NAME).toBe('Hale \u{1F33A}');
    expect(talk.cardNames).toContain('Hale \u{1F33A}');
    const sendAt = first.marks.indexOf('send');
    const cardAt = first.marks.indexOf('card');
    expect(sendAt).toBeGreaterThanOrEqual(0);
    expect(cardAt).toBeGreaterThan(sendAt);
    const vcard = readFileSync(
      fileURLToPath(new URL('../../../../site/lib/contact-card.ts', import.meta.url)),
      'utf8',
    );
    expect(vcard).toContain('FN:Hale \\u{1F33A}');
    expect(vcard).toContain('N:Hale;;;;');
    expect(vcard).toContain('ORG:Hale');
  });

  it('re-arms typing during a slow search and still stops only at the send', async () => {
    vi.useFakeTimers();
    const talk = conversation({
      search: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(findResult()), LINQ_TYPING_REFRESH_MS + 1_000),
        ),
    });
    const pending = talk.say("M5V 2T6 and she's 4");
    await vi.advanceTimersByTimeAsync(LINQ_TYPING_REFRESH_MS + 1_000);
    await vi.advanceTimersByTimeAsync(LINQ_CARD_REPLY_BUDGET_MS);
    const turn = await pending;
    const searchAt = turn.marks.indexOf('search');
    const stopAt = turn.marks.indexOf('typing-stop');
    expect(searchAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(searchAt);
    expect(turn.marks.slice(searchAt + 1, stopAt)).toContain('typing-start');
    assertTypingUntilSend(turn.marks);
    expect(turn.bodies.join('\n')).toMatch(/Which of these looks good\?$/);
  });

  it('does not hold the first reply for a slow card setup', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const talk = conversation();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const target = String(url);
        const method = init?.method ?? 'GET';
        if (target.includes('/typing')) {
          talk.marks.push(method === 'DELETE' ? 'typing-stop' : 'typing-start');
          return new Response(null, { status: 204 });
        }
        if (target.includes('/contact_card') && !target.includes('share_contact_card')) {
          talk.marks.push('card');
          await hung;
          return Response.json({
            phone_number: FROM,
            first_name: HALE_CONTACT_FIRST_NAME,
            is_active: true,
          });
        }
        return new Response(null, { status: 204 });
      }),
    );
    const pending = talk.say('hi');
    await vi.advanceTimersByTimeAsync(LINQ_CARD_REPLY_BUDGET_MS);
    const turn = await pending;
    expect(turn.marks.indexOf('send')).toBeGreaterThanOrEqual(0);
    expect(turn.marks.indexOf('card')).toBeGreaterThan(turn.marks.indexOf('send'));
    expect(turn.bodies.join('\n')).toMatch(/postal code\?$/);
    release();
  });

  it('never sends a known canned onboarding string', async () => {
    const talk = conversation();
    await talk.say('hi');
    await talk.say('M5V 2T6, Maya is 4');
    await talk.say('what is this?');
    await talk.say('the swim one');
    await talk.say("What's next");
    expect(talk.transport.bodies().length).toBeGreaterThan(0);
    expectNoCanned(talk.transport.bodies());
    const machine = conversation();
    await handleInboundSms(
      machine.fake.db,
      machine.transport.inbound(PHONE, 'hi', { transport: 'imessage', chatId: CHAT }),
      machine.deps,
    );
    expectNoCanned(machine.transport.bodies());
  });
});
