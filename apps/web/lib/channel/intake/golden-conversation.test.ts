import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AHA_TIME_ZONE,
  ahaWhenLabel,
  calendarFactsFromItems,
  calendarOverlaps,
  emailFactsFromMessages,
  emptyAha,
} from '~/lib/channel/connect/aha-read';
import { connectedReceiptBody } from '~/lib/channel/connect/connected-notice';
import { googleUnverifiedAppLine } from '~/lib/channel/connect/text-connect';
import { routeInboundText } from '~/lib/channel/inbound-route';
import {
  HALE_CONTACT_FIRST_NAME,
  LINQ_CARD_REPLY_BUDGET_MS,
} from '~/lib/channel/linq/contact-card';
import { LINQ_GROUP_ADD_THIS_NUMBER, LINQ_GROUP_TRIGGER_PHRASE } from '~/lib/channel/linq/group';
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
  INTAKE_COPARENT_ASK_TEMPLATE_KEY,
  SITTING_SESSION_REMINDER,
} from './copy';
import {
  FakeAddThemYourself,
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
  if (/is this free/i.test(words)) return 'The price is on villagehale.com.';
  if (/tell me a joke/i.test(words)) return "I'm not much of a comic.";
  if (/privacy|private/i.test(words))
    return 'I only keep what you send, and you can ask what I have.';
  if (/weather|recipe/i.test(words)) return "That's outside what I do.";
  if (/^(ok|lol|and|thanks)$/i.test(words) || /what's next/i.test(words)) return 'Got it.';
  return null;
}

/** The model's wire shape: the capture fields flat, the role as two strings. */
type WireCapture = Omit<OnboardingCapture, 'parentRole'> & {
  parentRole: 'mother' | 'father' | 'unknown' | null;
  parentRoleBasis: 'stated' | 'guessed' | null;
};

interface ScriptedTurn {
  reply: string;
  capture: WireCapture;
  groupLeads?: string[];
}

/**
 * Stand-in for the onboarding model. Production does not parse the message;
 * this fake does, so the tests can drive the ten steps with plain texts:
 * postal, kids' names, ages, the map (no question), the name, Gmail,
 * calendar, schedule, co-parent.
 */
function scriptedTurn(input: FriendVoiceInput): ScriptedTurn {
  const words = input.parentWords.trim();
  const capture: WireCapture = {
    ...EMPTY_ONBOARDING_CAPTURE,
    children: [],
    scheduleAdds: [],
    parentRole: null,
    parentRoleBasis: null,
  };
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
  if (capture.parentName) {
    // A unisex name stays unknown; the model never guesses off a name like Dana.
    capture.parentRole = 'unknown';
    capture.parentRoleBasis = 'guessed';
  }
  if (input.step === 'kids_names' && /^[A-Z][a-z]+$/.test(words)) {
    const age = input.ageMonths[0] ?? null;
    capture.children = [
      { name: words, ageMonths: age, agePrecision: age == null ? null : 'years' },
    ];
  }
  if (/\bcheck my calendar\b/i.test(words)) capture.connectCalendar = true;
  if (/\bwatch my email\b/i.test(words)) capture.connectGmail = true;
  if (/^(yes|yeah|yep)$/i.test(words)) {
    if (input.step === 'calendar') capture.connectCalendar = true;
    if (input.step === 'email') capture.connectGmail = true;
    if (input.step === 'coparent') capture.coparentGroup = true;
    if (
      input.step === 'schedule' &&
      input.findLines.length > 0 &&
      (input.scheduled ?? []).length === 0
    ) {
      const swimAt = input.findLines.findIndex((line) => /swim/i.test(line));
      capture.scheduleAdds = [
        {
          line: swimAt >= 0 ? swimAt + 1 : 1,
          cadence: 'weekly',
          date: '2026-08-01',
          time: null,
          weeks: null,
        },
      ];
    }
  }
  // The reminders are confirmed; the next reply closes the schedule.
  if (input.step === 'schedule' && (input.scheduled ?? []).length > 0) capture.scheduleDone = true;
  if (/^(no|nope)$/i.test(words)) {
    if (input.step === 'calendar') capture.connectCalendar = false;
    if (input.step === 'email') capture.connectGmail = false;
    if (input.step === 'schedule') capture.scheduleDone = true;
    if (input.step === 'coparent') capture.coparentGroup = false;
  }

  const postalKnown =
    Boolean(capture.postalCode) || Boolean(input.placeLabel) || input.checklist?.postal === true;
  const kidsKnown =
    (capture.children.length > 0 && capture.children.every((child) => Boolean(child.name))) ||
    input.checklist?.kids === true;
  const capturedAges = capture.children.filter((child) => child.ageMonths != null);
  const agesKnown =
    (capture.children.length > 0 && capturedAges.length === capture.children.length) ||
    input.ageMonths.length > 0 ||
    input.checklist?.ages === true;
  const nameKnown =
    Boolean(capture.parentName) || Boolean(input.parentName) || input.checklist?.name === true;
  const gmailKnown = capture.connectGmail != null || input.checklist?.gmail === true;
  const calendarKnown = capture.connectCalendar != null || input.checklist?.calendar === true;
  const scheduleKnown = capture.scheduleDone || input.checklist?.schedule === true;
  const coparentKnown = capture.coparentGroup != null || input.checklist?.coparent === true;
  const who = capture.parentName || input.parentName;

  if (input.step === 'find_show') {
    // Step 4: the map. A lead per group, no question anywhere.
    return {
      reply: 'Here is what is on near you for their ages.',
      capture,
      groupLeads: (input.findGroups ?? []).map(() => 'Worth a look.'),
    };
  }
  // Reminders just recorded: confirm them, ask nothing.
  if (capture.scheduleAdds.length > 0) {
    return { reply: 'Done, a weekly reminder for the swim.', capture };
  }
  // A yes to the group: the number, and the sentence or the phrase, ride below the reply.
  if (input.step === 'coparent' && /\bnew group\b/i.test(words)) {
    return {
      reply: 'Start a group text with them and the number below, then send the phrase below.',
      capture: { ...capture, coparentGroup: true, coparentGroupMode: 'new' },
    };
  }
  if (input.step === 'coparent' && capture.coparentGroup === true) {
    return { reply: 'Add the number below to your family group, whenever you like.', capture };
  }
  // A yes to the connector just asked is answered as a yes. The next ask
  // waits for the connect receipt or the next text.
  if (
    (input.step === 'email' && capture.connectGmail === true && !input.checklist?.gmail) ||
    (input.step === 'calendar' && capture.connectCalendar === true && !input.checklist?.calendar)
  ) {
    return {
      reply:
        "Great, the link is right there. Tap it when you're ready and I'll text you what I see.",
      capture,
    };
  }

  let ask: string;
  if (!postalKnown) ask = "Hey, it's Hale. What's your postal code?";
  else if (!kidsKnown) ask = "What are your kids' names?";
  else if (!agesKnown) ask = 'How old are your kids?';
  else if (!nameKnown) ask = 'What should I call you?';
  else if (!gmailKnown) {
    ask = who
      ? `${who}, want me to watch school and camp email for the dates?`
      : 'Want me to watch school and camp email for the dates?';
  } else if (!calendarKnown) {
    ask = who ? `${who}, want me to check your calendar?` : 'Want me to check your calendar?';
  } else if (!scheduleKnown && input.findLines.length > 0) {
    ask = 'Want the swim one on your calendar as a weekly reminder?';
  } else if (!coparentKnown) ask = 'Want me to set up a group chat with the other parent?';
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
  compose?: (input: FriendVoiceInput) => ScriptedTurn;
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
    addThemYourself: new FakeAddThemYourself(),
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
  it('walks postal, kids, ages, the map, name, Gmail, calendar, schedule, co-parent, then chat', async () => {
    const talk = conversation();
    const postal = await talk.say('hi');
    expect(postal.bodies.join('\n')).toMatch(/postal code\?$/);
    assertTypingUntilSend(postal.marks);

    // Step 2: the kids' names, before any ages or any find.
    const kids = await talk.say('M5V 2T6');
    expect(kids.bodies.join('\n')).toMatch(/kids' names\?$/);
    expect(kids.bodies.join('\n')).not.toMatch(/Swim/);
    assertTypingUntilSend(kids.marks);

    // Step 3: the ages.
    const ages = await talk.say('Maya');
    expect(ages.bodies.join('\n')).toMatch(/How old are your kids\?$/);
    expect(ages.bodies.join('\n')).not.toMatch(/Swim/);
    assertTypingUntilSend(ages.marks);

    // Step 4: the map in its own bubbles with no question, then the name ask on its own.
    const shown = await talk.say("she's 4");
    expect(shown.bodies.length).toBeGreaterThanOrEqual(2);
    const nameAsk = shown.bodies.at(-1) ?? '';
    const map = shown.bodies.slice(0, -1).join('\n');
    expect(map).toContain('Swim at the rec centre');
    expect(map).not.toContain('?');
    expect(map).not.toMatch(/which (one|of these)/i);
    expect(nameAsk).toMatch(/What should I call you\?$/);
    expect(nameAsk).not.toContain('Swim');
    assertTypingUntilSend(shown.marks);

    // Step 5: Gmail, its own turn, the link in the card.
    const parent = await talk.say('Dana');
    const gmail = parent.bodies.join('\n');
    expect(gmail.replace(/\nhttps:\/\/\S+/g, '')).toMatch(
      /Dana, want me to watch school and camp email for the dates\?$/,
    );
    expect(gmail).toMatch(/https:\/\//);
    expect(gmail).toContain('to=gmail');
    assertTypingUntilSend(parent.marks);

    // A yes to Gmail gets the receipt for the yes: no question, no second
    // link, nothing about the calendar. The calendar card rides the Gmail
    // receipt, or the next text when the parent never taps.
    const yes = await talk.say('yes');
    const yesBody = yes.bodies.join('\n');
    expect(yesBody).toContain('Tap it when');
    expect(yesBody).not.toMatch(/calendar|https:\/\//);
    expect(yesBody).not.toContain('?');
    assertTypingUntilSend(yes.marks);

    // Step 7: the calendar, its own turn, only after Gmail was answered.
    const calendar = await talk.say('ok');
    const calendarBody = calendar.bodies.join('\n');
    expect(calendarBody.replace(/\nhttps:\/\/\S+/g, '')).toMatch(
      /Dana, want me to check your calendar\?$/,
    );
    expect(calendarBody).not.toMatch(/gmail|email/i);
    expect(calendarBody).toContain('to=gcal');
    assertTypingUntilSend(calendar.marks);

    // Step 9: one found activity onto the calendar as a reminder. A yes to
    // the calendar is its receipt first; the next text brings the schedule.
    const calendarYes = await talk.say('yes');
    expect(calendarYes.bodies.join('\n')).toContain('Tap it when');
    expect(calendarYes.bodies.join('\n')).not.toContain('?');
    const schedule = await talk.say('ok');
    expect(schedule.bodies.join('\n')).toMatch(/weekly reminder\?$/);
    expect(schedule.bodies.join('\n')).not.toMatch(/https:\/\//);
    assertTypingUntilSend(schedule.marks);

    // The add is confirmed with no question; the next reply closes the schedule.
    const added = await talk.say('yes');
    expect(added.bodies.join('\n')).toBe('Done, a weekly reminder for the swim.');

    // Step 10: the co-parent, asked once and on its own, with nothing under it.
    const coparent = await talk.say('sounds good');
    expect(coparent.bodies.join('\n')).toMatch(/group chat with the other parent\?$/);
    expect(coparent.bodies.join('\n')).not.toContain(LINQ_GROUP_TRIGGER_PHRASE.en);
    expect(coparent.bodies.join('\n')).not.toMatch(/reminder/);
    assertTypingUntilSend(coparent.marks);

    const asks = talk.fake
      .rows(schema.channelMessages)
      .filter((row) => row.templateKey === INTAKE_COPARENT_ASK_TEMPLATE_KEY);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.direction).toBe('out');

    // A plain yes is the group they already have: Hale's number and the one locked
    // sentence under the model's prose, and no phrase.
    const joined = await talk.say('yes');
    const [joinProse, ...joinLines] = (joined.bodies[0] ?? '').split('\n');
    expect(joinProse).toMatch(/below/);
    expect(joinLines).toEqual(['+1 555-555-0100', LINQ_GROUP_ADD_THIS_NUMBER.en]);
    expect(joined.bodies.join('\n')).not.toContain(LINQ_GROUP_TRIGGER_PHRASE.en);

    expect(joined.outcome).toBe('intake');

    const chat = await talk.say('Maya loved the pool');
    expect(chat.outcome).toBe('handed_off');
    expect(chat.bodies).toEqual([]);
    expect(chat.marks).toContain('typing-start');
    expect(talk.transport.bodies().join('\n')).not.toMatch(/booked|enrolled|signed up|registered/i);
    expectNoCanned(talk.transport.bodies());
  });

  it('puts the phrase under a yes to a new group, and only then', async () => {
    const talk = conversation();
    for (const words of [
      'hi',
      'M5V 2T6',
      'Maya',
      "she's 4",
      'Dana',
      'yes',
      'ok',
      'yes',
      'ok',
      'yes',
    ]) {
      await talk.say(words);
    }
    const ask = await talk.say('sounds good');
    expect(ask.bodies.join('\n')).toMatch(/other parent\?$/);

    const joined = await talk.say("let's start a new group");
    const [joinProse, ...joinLines] = (joined.bodies[0] ?? '').split('\n');
    expect(joinProse).toMatch(/below/);
    expect(joinLines).toEqual(['+1 555-555-0100', LINQ_GROUP_TRIGGER_PHRASE.en]);
    expect(joined.bodies.join('\n')).not.toContain(LINQ_GROUP_ADD_THIS_NUMBER.en);
  });

  it('takes postal, kids, ages, a name, and both connections from the first message', async () => {
    const talk = conversation();
    const first = await talk.say(
      "M5V 2T6, Maya is 4, I'm Dana, check my calendar and watch my email",
    );
    const body = first.bodies.join('\n');
    expect(body).toContain('Swim at the rec centre');
    expect(body).not.toMatch(/postal code/i);
    expect(body).not.toMatch(/How old/);
    expect(body).not.toMatch(/kids' names/);
    expect(body).not.toMatch(/What should I call you/);
    expect(body).not.toMatch(/which (one|of these)/i);
    expect(first.bodies.length).toBeGreaterThan(0);
    assertTypingUntilSend(first.marks);
    expectNoCanned(talk.transport.bodies());
  });

  it('takes two items from one message, shows the map, and asks the next missing one', async () => {
    const talk = conversation();
    const first = await talk.say('M5V 2T6, Maya is 4');
    const map = first.bodies.slice(0, -1).join('\n');
    const ask = first.bodies.at(-1) ?? '';
    expect(map).toContain('Swim at the rec centre');
    expect(map).not.toContain('?');
    expect(ask).toMatch(/What should I call you\?$/);
    expect(first.bodies.join('\n')).not.toMatch(/How old/);
    expect(first.bodies.join('\n')).not.toMatch(/postal code\?$/);
    expect(first.bodies.join('\n')).not.toMatch(/which (one|of these)/i);
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
      {
        text: 'is this free?',
        aside: 'The price is on villagehale.com.',
        question: /postal code\?$/,
      },
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
    const kids = await talk.say('is this free?');
    expect(kids.bodies.join('\n')).toContain('The price is on villagehale.com.');
    expect(kids.bodies.join('\n')).toMatch(/kids' names\?$/);

    await talk.say('Maya');
    const ages = await talk.say('tell me a joke');
    expect(ages.bodies.join('\n')).toContain("I'm not much of a comic.");
    expect(ages.bodies.join('\n')).toMatch(/How old are your kids\?$/);

    await talk.say("she's 4");
    const name = await talk.say('is this private?');
    expect(name.bodies.join('\n')).toContain('I only keep what you send');
    expect(name.bodies.join('\n')).toMatch(/What should I call you\?$/);

    await talk.say('Dana');
    const email = await talk.say('what is the weather?');
    expect(email.bodies.join('\n')).toContain("That's outside what I do.");
    expect(email.bodies.join('\n').replace(/\nhttps:\/\/\S+/g, '')).toMatch(
      /email for the dates\?$/,
    );

    await talk.say('yes');
    const calendar = await talk.say('lol');
    expect(calendar.bodies.join('\n')).toContain('Got it.');
    expect(calendar.bodies.join('\n').replace(/\nhttps:\/\/\S+/g, '')).toMatch(/calendar\?$/);

    await talk.say('yes');
    const schedule = await talk.say('ok');
    expect(schedule.bodies.join('\n')).toContain('Got it.');
    expect(schedule.bodies.join('\n')).toMatch(/reminder\?$/);

    await talk.say('yes');
    const coparent = await talk.say("What's next");
    expect(coparent.bodies.join('\n')).toContain('Got it.');
    expect(coparent.bodies.join('\n').split('\n')[0]).toMatch(/other parent\?$/);
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
    const pending = talk.say('M5V 2T6 and Maya is 4');
    await vi.advanceTimersByTimeAsync(LINQ_TYPING_REFRESH_MS + 1_000);
    await vi.advanceTimersByTimeAsync(LINQ_CARD_REPLY_BUDGET_MS);
    const turn = await pending;
    const searchAt = turn.marks.indexOf('search');
    const stopAt = turn.marks.indexOf('typing-stop');
    expect(searchAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(searchAt);
    expect(turn.marks.slice(searchAt + 1, stopAt)).toContain('typing-start');
    assertTypingUntilSend(turn.marks);
    expect(turn.bodies.slice(0, -1).join('\n')).toContain('Swim at the rec centre');
    expect(turn.bodies.slice(0, -1).join('\n')).not.toContain('?');
    expect(turn.bodies.at(-1)).toMatch(/What should I call you\?$/);
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
    await talk.say('Dana');
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

  it('says one useful thing from the calendar or mailbox that just connected', async () => {
    const swimStart = '2026-09-12T13:00:00.000Z';
    const calendar = calendarFactsFromItems(
      [
        {
          summary: 'Swim at the rec centre',
          location: 'Rec centre',
          start: { dateTime: swimStart },
          end: { dateTime: '2026-09-12T14:00:00.000Z' },
        },
        {
          summary: 'Dentist',
          start: { dateTime: '2026-09-12T13:30:00.000Z' },
          end: { dateTime: '2026-09-12T14:30:00.000Z' },
        },
      ],
      new Date('2026-09-10T15:00:00.000Z'),
    );
    const synced = {
      provider: 'gcal' as const,
      read: 'ok' as const,
      calendar,
      email: [],
      overlaps: calendarOverlaps(calendar),
    };
    const when = ahaWhenLabel(swimStart, false, AHA_TIME_ZONE, 'en');
    const useful = await connectedReceiptBody(
      'en',
      'gcal',
      {
        async compose(input) {
          const chosen = input.synced?.calendar[0];
          const partner = input.synced?.overlaps[0]?.later;
          if (!chosen) return { reply: 'Your calendar is connected.', ahaMention: null };
          const clash = partner ? ` It overlaps ${partner}.` : '';
          return {
            reply: `${chosen.title} is on your calendar ${when}.${clash} I can remind you the evening before.`,
            ahaMention: chosen.title,
          };
        },
      },
      synced,
    );
    expect(useful).toContain('Swim at the rec centre');
    expect(useful).toContain(when);
    expect(useful).toContain('Dentist');
    expect(useful).not.toMatch(/\?/);
    expect(useful).not.toContain('Hockey');

    const mail = emailFactsFromMessages([
      {
        internalDate: '1757606400000',
        snippet: 'Register by Friday.',
        payload: {
          headers: [
            { name: 'Subject', value: 'Camp registration closes Friday' },
            { name: 'From', value: 'Camp Acorn <office@camp.example>' },
          ],
        },
      },
    ]);
    const emailAha = await connectedReceiptBody(
      'en',
      'gmail',
      {
        async compose(input) {
          const subject = input.synced?.email[0]?.subject;
          if (!subject) return { reply: 'Gmail is connected.', ahaMention: null };
          return {
            reply: `${subject} is in your email. I can remind you before it.`,
            ahaMention: subject,
          };
        },
      },
      { provider: 'gmail', read: 'ok', calendar: [], email: mail, overlaps: [] },
    );
    expect(emailAha).toContain('Camp registration closes Friday');
    expect(emailAha).not.toContain('office@camp.example');
    expect(emailAha).not.toMatch(/\?/);

    const quiet = await connectedReceiptBody(
      'en',
      'gcal',
      {
        async compose() {
          return { reply: 'Your calendar is connected.', ahaMention: null };
        },
      },
      emptyAha('gcal'),
    );
    expect(quiet).toBe('Your calendar is connected.');
    expect(quiet).not.toContain('Swim at the rec centre');
    expect(quiet).not.toContain('Camp registration');

    const pages: string[] = [];
    const invented = await connectedReceiptBody(
      'en',
      'gcal',
      {
        async compose() {
          return { reply: 'Hockey is on Thursday at 4:00.', ahaMention: 'Hockey' };
        },
      },
      synced,
      {
        page: async (text) => {
          pages.push(text);
        },
      },
    );
    expect(invented).toBe('');
    expect(pages).toEqual(['onboarding friend voice unsent step=connected reason=unusable']);
    expect(pages.join(' ')).not.toContain('Swim');
    expect(pages.join(' ')).not.toContain('Hockey');
  });
});
