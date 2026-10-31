import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFinder } from '~/lib/channel/activity/lane';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import type { IntakeCollected } from './extract';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from './fakes';
import { runFirstReplyRecoveryCron } from './first-reply-recovery';
import type { FriendVoiceComposer, FriendVoiceInput } from './friend-voice';
import { type IntakeDeps, handleInboundSms } from './machine';
import { EMPTY_ONBOARDING_CAPTURE } from './onboarding-turn';
import { loadOpenSession } from './session';
import { runSittingReminderCron } from './sitting-reminder';
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

import { scriptedTurn } from './scripted-friend-voice.fixture';

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
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    ...(options.weekFinder !== undefined ? { weekFinder: options.weekFinder } : {}),
    ...(options.voice !== false
      ? {
          friendVoice: {
            async compose(input: FriendVoiceInput) {
              // The composer hands back the model's wire fields; the role is two
              // flat strings there, not the typed guess the capture carries.
              const { capture, ...rest } = scriptedTurn(input);
              const { parentRole, ...fields } = capture;
              return {
                ...rest,
                capture: {
                  ...fields,
                  parentRole: parentRole?.role ?? null,
                  parentRoleBasis: parentRole?.basis ?? null,
                },
              };
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

describe('first touch ladder', () => {
  beforeEach(() => {
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  });

  it('asks for a postal code on iMessage and records the location card as skipped', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY, MAYA] });
    const first = await handleInboundSms(
      fake.db,
      inbound(transport, 'hi', { transport: 'imessage', chatId: 'chat-1' }),
      deps,
    );
    expect(first).toEqual({ status: 'first_touch', step: 'place_asked' });
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
    expect(transport.locationRequests).toEqual([]);

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
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
  });

  it('sends the empty-find line when the live lookup has nothing', async () => {
    const finder: ActivityFinder = {
      async find() {
        return { found: false, reason: 'no_picks' };
      },
    };
    const { fake, transport, deps } = harness({ weekFinder: finder });
    await handleInboundSms(fake.db, inbound(transport, 'Toronto'), deps);
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
  });

  it('skips the place ask for a known venue code', async () => {
    const { fake, transport, deps } = harness();
    const result = await handleInboundSms(fake.db, inbound(transport, 'Hi (via markham)'), deps);
    expect(result).toMatchObject({ status: 'first_touch' });
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
    expect(transport.locationRequests).toEqual([]);
    expect(transport.bodies().join('\n')).not.toMatch(/postal code/i);
  });
});

describe('cold-start discovery session', () => {
  beforeEach(() => {
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
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
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  });

  it('asks for a postal code in one question, not the locked sentence', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    expect(transport.bodies()).toEqual(["Hey, it's Hale. What's your postal code?"]);
    expect(transport.bodies()[0]?.match(/\?/g)).toHaveLength(1);
  });

  it('asks the kids names after the postal code, with no empty week find', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY], voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(transport.bodies()).toEqual(["What are your kids' names?"]);
  });

  it('takes the kids names, then asks their ages, one ask per message', async () => {
    const { fake, transport, deps } = harness({ extractions: [EMPTY, EMPTY], voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    const named = await handleInboundSms(fake.db, inbound(transport, 'Maya and Leo'), deps);
    expect(named).toEqual({ status: 'first_touch', step: 'ages_waiting' });
    expect(transport.bodies().at(-1)).toBe('How old are your kids?');
    expect(transport.bodies().at(-1)?.match(/\?/g)).toHaveLength(1);
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.collected.children.map((child) => child.name)).toEqual(['Maya', 'Leo']);
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
    expect(last.match(/\?/g)).toHaveLength(1);
  });

  it('shows the map with no question, asks the name next, then Gmail, calendar, schedule, co-parent', async () => {
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
    // Step 4: the map, its own bubbles, no question. Step 4b: the name, the next message.
    const [opener, map, nameAsk] = transport.bodies();
    expect(opener).not.toContain('?');
    expect(map).toContain('Swim (ages 3-5) - Saturdays 10am - $12');
    expect(map).not.toContain('?');
    expect(map).not.toMatch(/which (one|of these)/i);
    expect(map).not.toContain('Reply with the number you want.');
    expect(nameAsk).toBe('What should I call you?');
    expect(transport.bodies()).toHaveLength(3);

    // Step 5: Gmail, its own turn, link in the card.
    const named = await handleInboundSms(fake.db, inbound(transport, 'Dana'), timed);
    expect(named.status).toBe('first_touch');
    const gmail = transport.bodies().at(-1) ?? '';
    expect(gmail).toContain('Dana, want me to watch school and camp email for the dates?');
    expect(gmail).toContain('/connect?t=');
    expect(gmail).toContain('to=gmail');
    expect(gmail.replace(/https:\/\/\S+/g, '').match(/\?/g)).toHaveLength(1);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'parent_name_captured',
      ),
    ).toBe(true);

    // A yes to Gmail is its own receipt: no calendar link under a Gmail yes.
    await handleInboundSms(fake.db, inbound(transport, 'yes'), timed);
    const gmailYes = transport.bodies().at(-1) ?? '';
    expect(gmailYes).toContain('Tap it when');
    expect(gmailYes).not.toContain('/connect?t=');

    // Step 7: the calendar, only after they answered Gmail.
    await handleInboundSms(fake.db, inbound(transport, 'ok'), timed);
    const calendar = transport.bodies().at(-1) ?? '';
    expect(calendar).toContain('Dana, want me to check your calendar?');
    expect(calendar).toContain('to=gcal');
    expect(calendar).not.toMatch(/email/i);

    // Step 9: one activity, a sensible default, a reminder — not a registration.
    await handleInboundSms(fake.db, inbound(transport, 'yes'), timed);
    expect(transport.bodies().at(-1)).toContain('Tap it when');
    await handleInboundSms(fake.db, inbound(transport, 'ok'), timed);
    const schedule = transport.bodies().at(-1) ?? '';
    expect(schedule).toContain('Want the first one on your calendar as a weekly reminder?');
    expect(schedule).not.toContain('/connect?t=');

    await handleInboundSms(fake.db, inbound(transport, 'yes'), timed);
    const events = fake.rows(schema.familyEvents);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((row) => row.title === 'Swim')).toBe(true);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'onboarding_schedule_added',
      ),
    ).toBe(true);

    // The add is confirmed with no question; the next reply closes the schedule.
    expect(transport.bodies().at(-1)).toBe('Done, a weekly reminder for the first one.');
    await handleInboundSms(fake.db, inbound(transport, 'sounds good'), timed);

    // Step 10: the co-parent, asked once, after the schedule — not combined with it.
    const coparent = transport.bodies().at(-1) ?? '';
    expect(coparent).toBe('Want me to set up a group chat with the other parent?');
    await handleInboundSms(fake.db, inbound(transport, 'no'), timed);
    expect(transport.bodies().at(-1)).toBe('All set.');
    expect(await loadOpenSession(fake.db, PHONE)).toBeNull();
    expect(transport.bodies().join('\n')).not.toMatch(/booked|enrolled|signed up|registered/i);
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
    const { fake, transport, deps } = harness({ extractions: [EMPTY], voice: false });
    const outcome = await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    expect(outcome).toEqual({ status: 'first_touch_unsent', reason: 'voice_unavailable' });
    expect(transport.bodies()).toEqual([]);
    expect(transport.bodies().join('\n')).not.toContain('How old are the kids?');
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.state).toBe('awaiting_details');
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
    ['is this free?', 'The price is on villagehale.com.', "What's your postal code?"],
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

  it('answers a kids-names aside and keeps that question last', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'is this free?'), deps);
    const body = transport.bodies().at(-1) ?? '';
    expect(body).toContain('The price is on villagehale.com.');
    expect(body.trim().endsWith("What are your kids' names?")).toBe(true);
    expect((await loadOpenSession(fake.db, PHONE))?.state).toBe('awaiting_ages');
  });

  it('walks a session left in awaiting_details with the friend voice, not the unreadable door', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    const row = fake.rows(schema.smsIntakeSessions)[0];
    expect(row?.state).toBe('awaiting_place');
    // A row from before the walk: details state, greeting already out.
    if (row) row.state = 'awaiting_details';
    const result = await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    expect(result.status).toBe('first_touch');
    const body = transport.bodies().at(-1) ?? '';
    expect(body).toBe("Got it. What's your postal code?");
    expect(body).not.toMatch(/couldn't read|could not read/i);
    expect((await loadOpenSession(fake.db, PHONE))?.state).toBe('awaiting_place');
  });

  it('goes straight to the map when the first text has a postal code and ages, then asks the name', async () => {
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
    const bodies = transport.bodies();
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toContain('Swim (ages 3-5) - Saturday');
    expect(bodies[1]).not.toMatch(/^\d+\.\s/m);
    expect(bodies[1]).not.toContain('?');
    expect(bodies[2]).toBe('What should I call you?');
    expect(bodies.join('\n')).not.toMatch(/postal code|how old|which of these/i);
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

  it('skips the name after a combined postal, ages and name, and asks for Gmail', async () => {
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
      inbound(transport, "Maya is 4 and Leo is 1, M5V 2T6, I'm Dana. Is this free?"),
      deps,
    );
    expect(done.status).toBe('provisioned');
    const body = transport.bodies().at(-1) ?? '';
    expect(transport.bodies()).toHaveLength(3);
    expect(body).toContain('The price is on villagehale.com.');
    expect(body).toMatch(/email/i);
    expect(body).toContain('/connect?t=');
    expect(body).not.toMatch(/which of these|call you|postal code|how old/i);
    expect(
      body
        .replace(/https:\/\/\S+/g, '')
        .trim()
        .endsWith('?'),
    ).toBe(true);
  });
  it('answers off-script at the name, Gmail and calendar steps and keeps that question last', async () => {
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
    const joke = transport.bodies().at(-1) ?? '';
    expect(joke).toContain("I'm not much of a comic.");
    expect(joke.trim().endsWith('What should I call you?')).toBe(true);

    await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    const name = transport.bodies().at(-1) ?? '';
    expect(name).toContain('Got it.');
    expect(name.trim().endsWith('What should I call you?')).toBe(true);

    await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
    const gmail = transport.bodies().at(-1) ?? '';
    expect(gmail).toMatch(/email/i);
    expect(gmail).toContain('/connect?t=');

    await handleInboundSms(fake.db, inbound(transport, 'lol'), deps);
    const stillGmail = transport.bodies().at(-1) ?? '';
    expect(stillGmail).toContain('Got it.');
    expect(stillGmail).toMatch(/email/i);
    expect(stillGmail).not.toContain('/connect?t=');
    expect(stillGmail.trim().endsWith('?')).toBe(true);

    // A yes to Gmail is answered as a yes: no second link, no calendar yet. The
    // calendar card rides the Gmail receipt (connected-notice.ts).
    await handleInboundSms(fake.db, inbound(transport, 'yes'), deps);
    const yes = transport.bodies().at(-1) ?? '';
    expect(yes).toContain('Tap it when');
    expect(yes).not.toMatch(/calendar/i);
    expect(yes).not.toContain('/connect?t=');
    expect(yes).not.toContain('?');

    // The next text, with Gmail answered, is the calendar's own turn with its link.
    await handleInboundSms(fake.db, inbound(transport, 'ok'), deps);
    const calendar = transport.bodies().at(-1) ?? '';
    expect(calendar).toMatch(/calendar/i);
    expect(calendar).not.toMatch(/gmail|email/i);
    expect(calendar).toContain('/connect?t=');
    expect(calendar).toContain('to=gcal');
  });
  it('routes a crisis through the model reader and sends its reply before any ask', async () => {
    // #868: no token list and no fixed crisis line. The turn's reader routes the
    // crisis and writes the reply; the fixture stands in for the model.
    const crisisReader = (intent: 'crisis_emergency' | 'crisis_mental', reply: string) => ({
      read: async () => ({ intent, confirmation: reply }),
    });
    const { fake, transport, deps } = harness({ voice: true });
    deps.optOutReader = crisisReader('crisis_emergency', 'Emergency reply (test fixture).');
    const crisis = await handleInboundSms(fake.db, inbound(transport, 'not breathing'), deps);
    expect(crisis).toEqual({ status: 'first_touch', step: 'place_waiting' });
    expect(transport.bodies()).toEqual(['Emergency reply (test fixture).']);

    const { fake: fake2, transport: transport2, deps: deps2 } = harness({ voice: true });
    deps2.optOutReader = crisisReader('crisis_mental', 'Crisis line reply (test fixture).');
    const mental = await handleInboundSms(
      fake2.db,
      inbound(transport2, 'i cant do this anymore'),
      deps2,
    );
    expect(mental.status).toBe('first_touch');
    expect(transport2.bodies()).toEqual(['Crisis line reply (test fixture).']);

    // A crisis whose reply came back empty still ends the turn: no onboarding ask.
    const { fake: fake3, transport: transport3, deps: deps3 } = harness({ voice: true });
    deps3.optOutReader = crisisReader('crisis_emergency', '');
    await handleInboundSms(fake3.db, inbound(transport3, 'fire'), deps3);
    expect(transport3.bodies()).toEqual([]);
  });

  it('accepts a US ZIP and still replies when a city name is not a place', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'hi'), deps);
    await handleInboundSms(fake.db, inbound(transport, 'thanks'), deps);
    expect(transport.bodies().at(-1)).toContain('Got it.');
    expect(transport.bodies().at(-1)?.trim().endsWith("What's your postal code?")).toBe(true);

    await handleInboundSms(fake.db, inbound(transport, '10001'), deps);
    const zip = transport.bodies().at(-1) ?? '';
    expect(zip).not.toContain("What's your postal code?");
    expect((await loadOpenSession(fake.db, PHONE))?.state).not.toBe('awaiting_place');
    expect((await loadOpenSession(fake.db, PHONE))?.firstTouch?.place?.postalCode).toBe('10001');

    const { fake: cityFake, transport: cityTransport, deps: cityDeps } = harness({ voice: true });
    await handleInboundSms(cityFake.db, inbound(cityTransport, 'hi'), cityDeps);
    await handleInboundSms(cityFake.db, inbound(cityTransport, 'Chicago'), cityDeps);
    const city = cityTransport.bodies().at(-1) ?? '';
    expect(city.trim().endsWith("What's your postal code?")).toBe(true);
    expect((await loadOpenSession(cityFake.db, PHONE))?.firstTouch?.place).toBeNull();
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
    await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
    expect(transport.bodies().at(-1)).toContain(
      'Dana, want me to watch school and camp email for the dates?',
    );
  });

  it('stores the soft parent-role guess, and an explicit statement overrides it', async () => {
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
    await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
    const guessed = fake.rows(schema.users).find((row) => row.name === 'Dana');
    expect(guessed).toMatchObject({ parentRole: 'unknown', parentRoleBasis: 'guessed' });
    expect(transport.bodies().join('\n')).not.toMatch(/\b(mom|mum|dad|mother|father)\b/i);

    await handleInboundSms(fake.db, inbound(transport, "I'm her dad"), deps);
    const stated = fake.rows(schema.users).find((row) => row.name === 'Dana');
    expect(stated).toMatchObject({ parentRole: 'father', parentRoleBasis: 'stated' });
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'parent_role_recorded',
      ),
    ).toBe(true);
  });
  it('keeps the found activities for the schedule step without any pick gate', async () => {
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
    const session = await loadOpenSession(fake.db, PHONE);
    expect(session?.firstTouch?.coldStart?.findBody).toContain('Swim (ages 3-5)');
    expect(session?.firstTouch?.coldStart?.step).toBe('names');
    expect(transport.bodies().join('\n')).not.toMatch(/which (one|of these)/i);
    expect(transport.bodies().at(-1)).toBe('What should I call you?');
  });

  it('sends nothing when the map opener fails, and retries the map before the next ask', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    const voice = deps.friendVoice;
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
    deps.friendVoice = {
      async compose(input, options) {
        if (input.step === 'find_show') throw new Error('model down');
        if (!voice) throw new Error('voice missing');
        return voice.compose(input, options);
      },
    };
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    expect(transport.bodies()).toEqual([]);
    const owed = await loadOpenSession(fake.db, PHONE);
    expect(owed?.firstTouch?.coldStart?.findDelivered).toBe(false);
    expect(owed?.firstTouch?.coldStart?.nameLineSent).toBe(false);
    expect(owed?.firstTouch?.coldStart?.findBody).toContain('Swim (ages 3-5)');

    deps.friendVoice = voice;
    await handleInboundSms(fake.db, inbound(transport, 'still here'), deps);
    const sent = transport.bodies().join('\n');
    expect(sent).toContain('Here is what is on near you for their ages.');
    expect(sent).toContain('Swim (ages 3-5)');
    expect(sent).toContain('What should I call you?');
    const delivered = await loadOpenSession(fake.db, PHONE);
    expect(delivered?.firstTouch?.coldStart?.findDelivered).not.toBe(false);
  });
  it('updates the child age without re-running the find, and leaves the other family alone', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { fake, transport, deps } = harness({ voice: true });
    let calls = 0;
    deps.radar = {
      async compose() {
        calls += 1;
        return {
          message: '1. Storytime - Tuesday',
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
    const otherDob = '2010-01-01';
    await fake.db.insert(schema.children).values({
      familyId: '00000000-0000-4000-8000-000000000099',
      name: 'Other',
      dateOfBirth: otherDob,
      dobPrecision: 'exact',
    } as never);
    await handleInboundSms(fake.db, inbound(transport, 'Maya is 4, M5V 2T6'), deps);
    const before = fake.rows(schema.children).find((row) => row.name === 'Maya')?.dateOfBirth;
    await handleInboundSms(fake.db, inbound(transport, 'actually 5'), deps);
    expect(calls).toBe(1);
    const maya = fake.rows(schema.children).find((row) => row.name === 'Maya');
    const other = fake.rows(schema.children).find((row) => row.name === 'Other');
    expect(maya?.dateOfBirth).not.toBe(before);
    expect(other?.dateOfBirth).toBe(otherDob);
    expect(transport.bodies().at(-1)).toBe('What should I call you?');
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
    await handleInboundSms(fake.db, inbound(transport, 'no'), deps);
    const declined = await loadOpenSession(fake.db, PHONE);
    expect(declined?.firstTouch?.given?.nameDeclined).toBe(true);
    expect(transport.bodies().at(-1)).toMatch(/email/i);
    await handleInboundSms(fake.db, inbound(transport, 'later'), deps);
    const later = await loadOpenSession(fake.db, PHONE);
    expect(later?.firstTouch?.given?.gmailLater).toBe(true);
    expect(transport.bodies().at(-1)).toMatch(/calendar/i);
    expect(transport.bodies().at(-1)).not.toMatch(/email/i);
    await handleInboundSms(fake.db, inbound(transport, 'no'), deps);
    expect(transport.bodies().at(-1)).toBe(
      'Want the first one on your calendar as a weekly reminder?',
    );
    expect(transport.bodies().filter((body) => /email/i.test(body))).toHaveLength(1);
    expect(
      fake.writes.some(
        (write) =>
          write.op === 'insert' &&
          write.table === schema.auditLog &&
          write.payload.actionTaken === 'onboarding_ask_declined',
      ),
    ).toBe(true);
  });
  it('answers a next-day text on the current ask instead of retiring it', async () => {
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
    const staleAt = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString();
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
    const resumed = await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
    expect(resumed).toEqual({ status: 'first_touch', step: 'find_sent' });
    expect(transport.bodies().length).toBe(before + 1);
    expect(transport.bodies().at(-1)).toContain('Dana, want me to watch school and camp email');
    expect(fake.rows(schema.users).find((row) => row.name === 'Dana')).toBeDefined();
  });
  it('writes HELP from the model when friend voice is on', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    await handleInboundSms(fake.db, inbound(transport, 'HELP'), deps);
    const body = transport.bodies().at(-1) ?? '';
    expect(body).toContain('postal code');
    expect(body).not.toContain('Reply STOP');
    expect(body.trim().endsWith('?')).toBe(true);
  });

  it('retries once, then sends nothing and pages #ops when the model cannot write the turn', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.example/ops');
    const pages: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        pages.push(String(init?.body ?? ''));
        return new Response(null, { status: 200 });
      }),
    );
    try {
      let attempts = 0;
      const { fake, transport, deps } = harness({ voice: true });
      const broken: IntakeDeps = {
        ...deps,
        friendVoice: {
          async compose() {
            attempts += 1;
            throw new Error('model down: secret-token-123');
          },
        },
      };
      const outcome = await handleInboundSms(fake.db, inbound(transport, 'M5V 2T6'), broken);
      expect(outcome).toEqual({ status: 'first_touch_unsent', reason: 'model_failed' });
      expect(attempts).toBe(2);
      expect(transport.bodies()).toEqual([]);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain('onboarding friend voice unsent');
      expect(pages[0]).toContain('reason=model_failed');
      expect(pages[0]).not.toContain('secret-token-123');
      expect(pages[0]).not.toContain('M5V');
      // Code does not read the postal code itself, so nothing was stored, and the
      // opening is still owed: the parent's re-text re-runs it, and so does the sweep.
      const session = await loadOpenSession(fake.db, PHONE);
      expect(session?.state).toBe('awaiting_details');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names a first text that got no reply, and leaves it recoverable', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    let modelUp = false;
    const flaky: IntakeDeps = {
      ...deps,
      friendVoice: {
        async compose(input) {
          if (!modelUp) throw new Error('model down');
          return { reply: scriptedTurn(input).reply };
        },
      },
    };

    const silent = await handleInboundSms(fake.db, inbound(transport, 'hi'), flaky);

    expect(silent).toEqual({ status: 'first_touch_unsent', reason: 'model_failed' });
    expect(transport.sent).toHaveLength(0);
    const [row] = fake.rows(schema.smsIntakeSessions);
    expect(row?.firstReplyRecoveredAt).toBeNull();
    expect(row?.state).toBe('awaiting_details');
    const stored = await loadOpenSession(fake.db, PHONE);
    expect(stored?.transcript.map((entry) => entry.direction)).toEqual(['in']);

    // Positive control: the parent's own re-text re-runs the opening, and a model that
    // answers sends the reply this time.
    modelUp = true;
    const answered = await handleInboundSms(fake.db, inbound(transport, 'hello?'), flaky);
    expect(answered).toEqual({ status: 'first_touch', step: 'place_asked' });
    expect(transport.bodies()).toEqual(["Hey, it's Hale. What's your postal code?"]);
    expect(fake.rows(schema.smsIntakeSessions)[0]?.firstReplyRecoveredAt).toBeNull();
  });

  it('is answered once by the first-reply sweep when the opening turn sent nothing', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    let modelUp = false;
    const voice: FriendVoiceComposer = {
      async compose(input) {
        if (!modelUp) throw new Error('model down');
        return { reply: scriptedTurn(input).reply };
      },
    };
    await handleInboundSms(fake.db, inbound(transport, 'hi'), { ...deps, friendVoice: voice });
    const [row] = fake.rows(schema.smsIntakeSessions);
    if (!row) throw new Error('no session row');
    // The column defaults the fake does not apply: the silent turn ended five minutes ago.
    row.createdAt = new Date(NOW.getTime() - 5 * 60_000);
    row.updatedAt = row.createdAt;

    modelUp = true;
    const sweep = {
      transport,
      friendVoice: voice,
      limiter: deps.limiter,
      preflight: async () => ({ proceed: true as const, health: null }),
    };
    const first = await runFirstReplyRecoveryCron(fake.db, sweep, NOW);
    const second = await runFirstReplyRecoveryCron(
      fake.db,
      sweep,
      new Date(NOW.getTime() + 3 * 60_000),
    );

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(transport.bodies()).toEqual(["Hey, it's Hale. What's your postal code?"]);
    expect((await loadOpenSession(fake.db, PHONE))?.state).toBe('awaiting_place');
  });

  it('bounds the opening turn model budget so the sweep can retry within minutes', async () => {
    // The spec ceiling for both opening attempts together, not the production constant.
    const OPENING_BUDGET_CEILING_MS = 10_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { fake, transport, deps } = harness({ voice: true });
      const hung: IntakeDeps = {
        ...deps,
        friendVoice: { compose: () => new Promise(() => {}) },
      };
      let settled: unknown = null;
      const turn = handleInboundSms(fake.db, inbound(transport, 'hi'), hung).then((outcome) => {
        settled = outcome;
      });
      await vi.advanceTimersByTimeAsync(OPENING_BUDGET_CEILING_MS);
      expect(settled).toEqual({ status: 'first_touch_unsent', reason: 'model_failed' });
      await turn;
      expect(transport.sent).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the morning nudge after a real provisioning', () => {
    /** 7:00 p.m. Toronto the evening before the nudge. */
    const EVENING_BEFORE = new Date('2026-07-30T23:00:00.000Z');
    /** 8:05 a.m. Toronto the next morning — inside the nudge slot. */
    const NEXT_MORNING = new Date('2026-07-31T12:05:00.000Z');
    const swimRadar: IntakeDeps['radar'] = {
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

    const nudgeVoice: FriendVoiceComposer = {
      async compose(input) {
        if (input.step !== 'nudge_find') throw new Error(`unexpected step ${input.step}`);
        return { reply: 'Still here if one of those looks good. Which of these looks good?' };
      },
    };

    async function provisioned() {
      vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
      const built = harness({ extractions: [MAYA, EMPTY], voice: true });
      built.deps.radar = swimRadar;
      const done = await handleInboundSms(
        built.fake.db,
        inbound(built.transport, 'Maya is 4 and Leo is 1, M5V 2T6'),
        built.deps,
      );
      expect(done.status).toBe('provisioned');
      const [row] = built.fake.rows(schema.smsIntakeSessions);
      if (!row) throw new Error('provisioned: no session row');
      // The column default the fake does not apply.
      row.createdAt = EVENING_BEFORE;
      return { ...built, row };
    }

    it('nudges a quiet family once, at 08:00 Toronto the next day', async () => {
      const { fake, transport, row } = await provisioned();
      await expect(loadOpenSession(fake.db, PHONE)).resolves.toMatchObject({
        firstTouch: { coldStart: { step: 'names' } },
      });
      const before = transport.bodies().length;

      const first = await runSittingReminderCron(
        fake.db,
        { transport, friendVoice: nudgeVoice },
        NEXT_MORNING,
      );
      expect(first).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
      expect(transport.bodies().slice(before)).toHaveLength(1);
      expect(transport.bodies().at(-1)).toContain('Still here if one of those looks good.');
      expect(transport.bodies().at(-1)).toContain('1. Swim (ages 3-5) - Saturday');
      expect(row.sittingReminderSentAt).toEqual(NEXT_MORNING);

      const second = await runSittingReminderCron(
        fake.db,
        { transport, friendVoice: nudgeVoice },
        NEXT_MORNING,
      );
      expect(second.sent).toBe(0);
      expect(transport.bodies().slice(before)).toHaveLength(1);
    });

    it('does not nudge a family that replied after the find', async () => {
      const { fake, transport, deps } = await provisioned();
      await handleInboundSms(fake.db, inbound(transport, 'Dana'), deps);
      const before = transport.bodies().length;

      const result = await runSittingReminderCron(
        fake.db,
        { transport, friendVoice: nudgeVoice },
        NEXT_MORNING,
      );
      expect(result.sent).toBe(0);
      expect(transport.bodies()).toHaveLength(before);
    });

    it('releases the claim when the model writes nothing, so the next morning retries', async () => {
      const { fake, transport, row } = await provisioned();
      const before = transport.bodies().length;

      const result = await runSittingReminderCron(
        fake.db,
        {
          transport,
          friendVoice: {
            async compose() {
              throw new Error('model down');
            },
          },
        },
        NEXT_MORNING,
      );
      expect(result).toEqual({ evaluated: 1, sent: 0, skipped: 0, failed: 1 });
      expect(transport.bodies()).toHaveLength(before);
      expect(row.sittingReminderSentAt).toBeNull();
    });
  });
});

describe('#868 opt-out reader decides every turn, and a failed read holds the sender', () => {
  const reader = (intent: 'stop' | 'start' | 'none', confirmation: string) => ({
    read: async () => ({ intent, confirmation }),
  });
  const recorder = () => {
    const calls: string[] = [];
    return {
      calls,
      port: {
        hold: async (hash: string) => void calls.push(`hold:${hash.length > 0}`),
        release: async (hash: string) => void calls.push(`release:${hash.length > 0}`),
      },
    };
  };

  it('a STOP the reader reads as none is ordinary conversation: no word list', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    deps.optOutReader = reader('none', '');
    const result = await handleInboundSms(fake.db, inbound(transport, 'STOP'), deps);
    expect(result.status).not.toBe('stopped');
  });

  it('any wording of stop revokes and sends the model confirmation', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    deps.optOutReader = reader('stop', 'Stop confirmation (test fixture).');
    const result = await handleInboundSms(fake.db, inbound(transport, 'pls leave me alone'), deps);
    expect(result.status).toBe('stopped');
    expect(transport.bodies()).toEqual(['Stop confirmation (test fixture).']);
  });

  it('a read that fails (after its retry) holds the sender', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    const held = recorder();
    deps.optOutReader = { read: async () => null };
    deps.optOutHold = held.port;
    await handleInboundSms(fake.db, inbound(transport, 'unreadable for now'), deps);
    expect(held.calls).toContain('hold:true');
    expect(held.calls).not.toContain('release:true');
  });

  it('a read that succeeds releases the hold', async () => {
    const { fake, transport, deps } = harness({ voice: true });
    const held = recorder();
    deps.optOutReader = reader('none', '');
    deps.optOutHold = held.port;
    await handleInboundSms(fake.db, inbound(transport, 'hello again'), deps);
    expect(held.calls).toEqual(['release:true']);
  });
});
