/**
 * Two ways intake used to drop what the parent was owed: a map retried without
 * one group's bubble, and a stop whose reply still asked a question. The
 * model's output is stipulated through the composer seam the intake tests
 * already use; what is under test is the code's handling of that output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUBBLE_GAP_MS } from '~/lib/channel/linq/bubble-gap';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { groupsFromFindBody } from './activity-map';
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
import type { FriendVoiceComposer, FriendVoiceInput } from './friend-voice';
import { type IntakeDeps, handleInboundSms } from './machine';
import { scriptedTurn } from './scripted-friend-voice.fixture';
import { loadOpenSession } from './session';
import { FakeTransport, type InboundMessage } from './transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165550123';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const EMPTY: IntakeCollected = { children: [], postalCode: null };

const SWIM = 'Parent and tot swim at the rec centre (ages 3-5) - Saturdays 10am';
const STORY = 'Storytime at the branch library (ages 2-6) - Tuesdays 10:30am';

function twoGroupRadar() {
  return {
    message: `[swimming]\n1. ${SWIM}\n[free_public]\n2. ${STORY}`,
    groups: [
      {
        category: 'swimming' as const,
        lines: [SWIM],
        titles: ['Parent and tot swim at the rec centre'],
      },
      {
        category: 'free_public' as const,
        lines: [STORY],
        titles: ['Storytime at the branch library'],
      },
    ],
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

function scripted(): FriendVoiceComposer {
  return {
    async compose(input: FriendVoiceInput) {
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
  };
}

function harness(): { fake: FakeDb; transport: FakeTransport; deps: IntakeDeps } {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const deps = {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([EMPTY]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: {
      async compose() {
        return twoGroupRadar();
      },
    },
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    friendVoice: scripted(),
    now: NOW,
  } as unknown as IntakeDeps;
  return { fake, transport, deps };
}

function inbound(transport: FakeTransport, body: string): InboundMessage {
  return transport.inbound(PHONE, body);
}

/** The model omits the bubble for group 1 (an empty element), as Devin describes. */
function omitsGroupOne(voice: FriendVoiceComposer): FriendVoiceComposer {
  return {
    async compose(input, options) {
      const base = await voice.compose(input, options);
      if (input.step !== 'find_show') return base;
      return { ...base, groupLeads: [SWIM, ''] };
    },
  };
}

async function evidence(fake: FakeDb, transport: FakeTransport) {
  const after = await loadOpenSession(fake.db, PHONE);
  const sent = transport.bodies().join('\n');
  const row = {
    bodies: transport.bodies(),
    sessionOpen: after != null,
    state: after?.state ?? null,
    findDelivered: after?.firstTouch?.coldStart?.findDelivered ?? '(absent)',
    swimSent: sent.includes('rec centre'),
    storySent: sent.includes('branch library'),
  };
  return { after, sent, row };
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('Devin #982 finding 1: unsent map group on retry', () => {
  it('F1-retry: an owed map retried with no bubble for group 1 sends group 1 or stays owed', async () => {
    const { fake, transport, deps } = harness();
    const voice = scripted();
    deps.friendVoice = {
      async compose(input, options) {
        if (input.step === 'find_show') throw new Error('model down');
        return voice.compose(input, options);
      },
    };
    await handleInboundSms(fake.db, inbound(transport, 'Ada is 4, H0H 0H0'), deps);
    expect(transport.bodies()).toEqual([]);
    const owed = await loadOpenSession(fake.db, PHONE);
    expect(owed?.firstTouch?.coldStart?.findDelivered).toBe(false);
    expect(
      groupsFromFindBody(owed?.firstTouch?.coldStart?.findBody ?? '').map((group) => group.lines),
    ).toEqual([[SWIM], [STORY]]);

    let retryMapCalls = 0;
    const omitting = omitsGroupOne(voice);
    deps.friendVoice = {
      async compose(input, options) {
        if (input.step === 'find_show') retryMapCalls += 1;
        return omitting.compose(input, options);
      },
    };
    await handleInboundSms(fake.db, inbound(transport, 'still here'), deps);
    const { row } = await evidence(fake, transport);
    expect(retryMapCalls, 'the owed map was retried this turn').toBeGreaterThan(0);
    expect(
      row.storySent || row.findDelivered === false,
      'stored group 1 was neither sent nor kept owed',
    ).toBe(true);
  });

  it('F1-control: the same retry with both bubbles sends group 1 and clears the debt', async () => {
    const { fake, transport, deps } = harness();
    const voice = scripted();
    deps.friendVoice = {
      async compose(input, options) {
        if (input.step === 'find_show') throw new Error('model down');
        return voice.compose(input, options);
      },
    };
    await handleInboundSms(fake.db, inbound(transport, 'Ada is 4, H0H 0H0'), deps);
    expect(transport.bodies()).toEqual([]);
    deps.friendVoice = voice;
    await handleInboundSms(fake.db, inbound(transport, 'still here'), deps);
    const { row } = await evidence(fake, transport);
    expect(row.swimSent).toBe(true);
    expect(row.storySent).toBe(true);
    expect(row.findDelivered).not.toBe(false);
  });

  it("F1-devin-example: group 1's send fails mid-map, then the retry writes only group 0", async () => {
    const { fake, transport, deps } = harness();
    const voice = scripted();
    const realSend = transport.send.bind(transport);
    let storyDown = true;
    transport.send = async (input) => {
      if (storyDown && input.body.includes('branch library')) throw new Error('transport down');
      return realSend(input);
    };
    const first = await handleInboundSms(fake.db, inbound(transport, 'Ada is 4, H0H 0H0'), deps);
    expect(first).toMatchObject({ status: 'provisioned', mapOwed: 'send_failed' });
    const owed = await loadOpenSession(fake.db, PHONE);
    expect(owed?.firstTouch?.coldStart?.findDelivered).toBe(false);
    storyDown = false;
    deps.friendVoice = omitsGroupOne(voice);
    await handleInboundSms(fake.db, inbound(transport, 'still here'), deps);
    const { row } = await evidence(fake, transport);
    expect(row.swimSent).toBe(true);
    expect(
      row.storySent || row.findDelivered === false,
      'group 1 never reached the parent and the map is not owed',
    ).toBe(true);
  });
});

describe('Devin #982 finding 2: stopAsking paired with a question', () => {
  async function atCalendarAsk() {
    const h = harness();
    await handleInboundSms(h.fake.db, inbound(h.transport, 'Ada is 4, H0H 0H0'), h.deps);
    await handleInboundSms(h.fake.db, inbound(h.transport, 'no'), h.deps);
    await handleInboundSms(h.fake.db, inbound(h.transport, 'later'), h.deps);
    // The calendar card is its prose, then its link once as its own text (VIL-573).
    expect(h.transport.bodies().at(-2)).toMatch(/calendar/i);
    expect(h.transport.bodies().at(-1)).toMatch(/^https:\/\/\S+\/connect\?t=\S+$/);
    expect(await loadOpenSession(h.fake.db, PHONE)).not.toBeNull();
    return h;
  }

  /** At the calendar ask, the parent's "later" gets this reply on every attempt. */
  function laterReply(
    voice: FriendVoiceComposer,
    reply: string,
    stopAsking: boolean,
    asks: boolean | 'omit' = true,
  ): FriendVoiceComposer {
    return {
      async compose(input, options) {
        const base = await voice.compose(input, options);
        if (input.step !== 'calendar' || !/^later$/i.test(input.parentWords.trim())) return base;
        const {
          stillAsking: _omitted,
          stopAsking: _stop,
          ...capture
        } = (base.capture ?? {}) as Record<string, unknown>;
        const { asks: _asks, ...wire } = base as unknown as Record<string, unknown>;
        return {
          ...wire,
          reply,
          ...(asks === 'omit' ? {} : { asks }),
          capture: { ...capture, calendarLater: true, stopAsking },
        } as Awaited<ReturnType<FriendVoiceComposer['compose']>>;
      },
    };
  }

  const MIXED =
    'No worries, later works. Want the first one on your calendar as a weekly reminder?';

  async function answerLater(h: Awaited<ReturnType<typeof atCalendarAsk>>) {
    const before = h.transport.bodies().length;
    await handleInboundSms(h.fake.db, inbound(h.transport, 'later'), h.deps);
    const turn = h.transport.bodies().slice(before);
    const open = await loadOpenSession(h.fake.db, PHONE);
    return { turn, open };
  }

  it('F2-mixed: stopAsking true, no stillAsking, reply asks the next thing: intake stays open', async () => {
    const h = await atCalendarAsk();
    h.deps.friendVoice = laterReply(scripted(), MIXED, true);
    const { turn, open } = await answerLater(h);
    expect(open, 'intake closed while the reply asked a question').not.toBeNull();
    expect(
      turn.length === 0 || turn.some((body) => body.includes('?')),
      'the question was stripped from what was sent',
    ).toBe(true);
  });

  it('F2-mixed-noasks: same, and the model also omits its asks mark: intake stays open', async () => {
    const h = await atCalendarAsk();
    h.deps.friendVoice = laterReply(scripted(), MIXED, true, 'omit');
    const { turn, open } = await answerLater(h);
    expect(open, 'intake closed while the reply asked a question').not.toBeNull();
    expect(
      turn.length === 0 || turn.some((body) => body.includes('?')),
      'the question was stripped from what was sent',
    ).toBe(true);
  });

  it("F2-devin-example: 'Want a group chat?' with stopAsking true and no stillAsking", async () => {
    const h = await atCalendarAsk();
    h.deps.friendVoice = laterReply(scripted(), 'Want a group chat?', true);
    const { turn, open } = await answerLater(h);
    expect(open, 'intake closed while the reply asked a question').not.toBeNull();
    expect(
      turn.length === 0 || turn.some((body) => body.includes('?')),
      'the question was stripped from what was sent',
    ).toBe(true);
  });

  it('F2-control: the same reply with stopAsking false goes out whole and intake stays open', async () => {
    const h = await atCalendarAsk();
    h.deps.friendVoice = laterReply(scripted(), MIXED, false);
    const { turn, open } = await answerLater(h);
    expect(open).not.toBeNull();
    expect(turn.some((body) => body.includes('?'))).toBe(true);
  });
});

describe('VIL-682 K5: the map bubbles on an iMessage chat arrive paced', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run the turn on the fake clock, stepping it until the turn settles. */
  async function onFakeClock<T>(work: Promise<T>): Promise<T> {
    let settled = false;
    void work.finally(() => {
      settled = true;
    });
    while (!settled) await vi.advanceTimersByTimeAsync(100);
    return work;
  }

  /** Milliseconds between the swim bubble and the storytime bubble of the map, on a Linq
   * chat Linq said `service` carried. */
  async function mapGap(
    flag: 'true' | 'false',
    service: InboundMessage['service'],
  ): Promise<number> {
    vi.useFakeTimers();
    vi.stubEnv('COACH_BUBBLES_ENABLED', flag);
    const { fake, transport, deps } = harness();
    const sentAt = new Map<string, number>();
    const send = transport.send.bind(transport);
    transport.send = async (input) => {
      sentAt.set(input.body, Date.now());
      return send(input);
    };
    const first = await onFakeClock(
      handleInboundSms(
        fake.db,
        transport.inbound(PHONE, 'Ada is 4, H0H 0H0', {
          transport: 'imessage',
          chatId: 'chat-1',
          ...(service ? { service } : {}),
        }),
        deps,
      ),
    );
    expect(first).toMatchObject({ status: 'provisioned' });
    const at = (needle: string) =>
      [...sentAt].find(([body]) => body.includes(needle))?.[1] ?? Number.NaN;
    return at('branch library') - at('rec centre');
  }

  it('lit: the next map bubble waits about two seconds', async () => {
    expect(await mapGap('true', 'iMessage')).toBe(BUBBLE_GAP_MS);
  });

  it('dark: the map bubbles go back to back', async () => {
    expect(await mapGap('false', 'iMessage')).toBe(0);
  });

  // Linq relays green-bubble SMS and RCS chats as `imessage` too; only the service it
  // named on the parent's text says the chat is really iMessage.
  it.each([['SMS'], ['RCS'], [undefined]] as const)(
    'lit, on a Linq chat Linq said is %s: the map bubbles go back to back',
    async (service) => {
      expect(await mapGap('true', service)).toBe(0);
    },
  );
});
