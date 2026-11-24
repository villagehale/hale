import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentChannelSigninToken } from '~/lib/auth/channel-signin';
import { withoutConnectTokens } from '~/lib/channel/connect/connect-link';
import { connectOfferTarget } from '~/lib/channel/connect/detect';
import type { DisconnectReader } from '~/lib/channel/connect/disconnect-read';
import { textFreshConnectorLink } from '~/lib/channel/connect/fresh-link';
import { routeInboundText } from '~/lib/channel/inbound-route';
import { HALE_CONTACT_FIRST_NAME } from '~/lib/channel/linq/contact-card';
import { recordLinqEditWebhook } from '~/lib/channel/linq/edit';
import { connectorDisconnectHandler } from '~/lib/channel/router/handlers';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { scriptedSaidLine } from '~/lib/channel/voice/scripted-said-line.fixture';
import type { GoogleDisconnectPorts } from '~/lib/integrations/google-disconnect';
import { saveConnection } from '~/lib/integrations/store';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  INTAKE_GOOGLE_CARD_TEMPLATE_KEY,
  googleCardDedupeKey,
  sendYearConnectorCards,
} from './connector-offer';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
} from './fakes';
import { type FriendVoiceInput, friendFactSlots, friendVoiceContext } from './friend-voice';
import { type ScriptedTurn, findResult, v2Turn } from './golden-conversation-v2.fixture';
import type { IntakeDeps } from './machine';
import { loadOpenSession, saveSession } from './session';
import { FakeTransport, type InboundMessage } from './transport';

/**
 * The five fixes the in-thread walk needs before its flag can go on, each driven through the
 * real door on real Postgres. A stand-in sits at the composer port; nothing here calls a model.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+15555550177';
const CHAT = '11111111-2222-4333-8444-555555555501';
const GROUP_CHAT = '11111111-2222-4333-8444-555555555502';
const FROM = '+15555550100';
const T0 = new Date('2026-07-30T12:00:00.000Z');
const SIX_MINUTES = 6 * 60_000;
const LINK = /https:\/\/\S+/g;
const TOKEN_PARAM = /[?&]t=/;
const UP_TO_ACTIVITIES = ['hi', 'M5V 2T6', 'Maya', "she's 4"];
const UP_TO_NAME = [...UP_TO_ACTIVITIES, 'she swims on Saturdays'];
const LEAVE = 'take Hale off my Google account';
const HEALTH_WORDS = 'she has speech therapy on Tuesdays';
const HEALTH = 'speech therapy';

const ports: GoogleDisconnectPorts = {
  revoker: { revoke: async () => ({ outcome: 'revoked' }) },
  google: {
    async request() {
      throw new Error('push is off in this suite');
    },
  },
  tokenFetch: async () => {
    throw new Error('push is off in this suite');
  },
  env: {},
  now: () => T0,
};
const disconnectRead: DisconnectReader = { read: async () => 'disconnect' };

type FetchOverride = (url: string, init?: RequestInit) => Promise<Response | null>;

function conversation(
  database: TestDb['database'],
  compose: (input: FriendVoiceInput) => ScriptedTurn = v2Turn,
) {
  const transport = new FakeTransport();
  const seen: FriendVoiceInput[] = [];
  const enqueued: { channel_message_id: string }[] = [];
  let clock = new Date(T0.getTime() - 60_000);
  let fetchOverride: FetchOverride | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const target = String(url);
      const overridden = await fetchOverride?.(target, init);
      if (overridden) return overridden;
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
    threadMessage: threadProactiveMessage,
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
    capture: async () => 'sent' as const,
    now: clock,
  });
  const deliver = (inbound: InboundMessage) =>
    routeInboundText(
      {
        database,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        countOutcome: async () => undefined,
        intake: () => ({ ...deps(), now: clock }),
        enqueue: async (job: { channel_message_id: string }) => {
          enqueued.push(job);
        },
        now: () => clock,
      } as Parameters<typeof routeInboundText>[0],
      inbound,
    );
  let sequence = 0;
  let last: InboundMessage | null = null;
  return {
    transport,
    seen,
    enqueued,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => clock,
    onFetch: (override: FetchOverride | null) => {
      fetchOverride = override;
    },
    say: async (body: string, where: { group?: boolean } = {}) => {
      sequence += 1;
      clock = new Date(clock.getTime() + 60_000);
      vi.setSystemTime(clock);
      const sentFrom = transport.bodies().length;
      const seenFrom = seen.length;
      last = {
        from: PHONE,
        body,
        providerId: `before-lighting-${sequence}`,
        receivedAt: clock,
        transport: 'imessage',
        chatId: where.group ? GROUP_CHAT : CHAT,
        isGroup: where.group === true,
      };
      const outcome = await deliver(last);
      return {
        outcome,
        bodies: transport.bodies().slice(sentFrom),
        inputs: seen.slice(seenFrom),
      };
    },
    redeliver: async () => {
      if (!last) throw new Error('nothing to redeliver');
      const sentFrom = transport.bodies().length;
      const seenFrom = seen.length;
      const outcome = await deliver(last);
      return {
        outcome,
        bodies: transport.bodies().slice(sentFrom),
        inputs: seen.slice(seenFrom),
      };
    },
  };
}

const linksIn = (bodies: readonly string[]) => bodies.flatMap((body) => body.match(LINK) ?? []);

const readAs = (ask: string, handOff: string) => (input: FriendVoiceInput) => {
  const turn = v2Turn(input);
  if (input.parentWords !== ask) return turn;
  return { ...turn, capture: { ...turn.capture, handOff } as ScriptedTurn['capture'] };
};

/** The model reading a health activity, marked as health, off the parent's words. */
const readsHealth = (input: FriendVoiceInput): ScriptedTurn => {
  const turn = v2Turn(input);
  if (input.parentWords !== HEALTH_WORDS) return turn;
  return {
    ...turn,
    capture: {
      ...turn.capture,
      activities: [{ child: 'Maya', activity: HEALTH, when: 'Tuesdays', health: true }],
    },
  };
};

const sendAsImessage = (talk: ReturnType<typeof conversation>) => {
  const real = talk.transport.send.bind(talk.transport);
  vi.spyOn(talk.transport, 'send').mockImplementation(async (input) => ({
    ...(await real(input)),
    transport: 'imessage' as const,
    chatId: CHAT,
  }));
};

const carriesHealth = (input: FriendVoiceInput) => ({
  context: JSON.stringify(friendVoiceContext(input)).includes(HEALTH),
  slots: friendFactSlots(input).some((slot) => slot.includes(HEALTH)),
});

describe('the in-thread walk, before its flag goes on', () => {
  let db: TestDb;

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    process.env.APP_ENCRYPTION_KEY = '';
    await db.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'false');
    vi.stubEnv('FRIEND_VOICE_MODEL_FIELDS_ENABLED', 'false');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', FROM);
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await db.exec('drop trigger if exists before_lighting_fail on audit_log');
    await db.exec('drop trigger if exists before_lighting_fail on channel_messages');
    await db.exec(
      'truncate table families, users, sms_intake_sessions, sms_intake_turn_claims, opt_out_held_messages cascade',
    );
  });

  const onlyFamily = async () => {
    const [family] = await db.database.select({ id: schema.families.id }).from(schema.families);
    if (!family) throw new Error('no family');
    const [parent] = await db.database.select({ id: schema.users.id }).from(schema.users);
    if (!parent) throw new Error('no parent');
    return { familyId: family.id, parentUserId: parent.id };
  };

  const openSession = async () => {
    const session = await loadOpenSession(db.database, PHONE);
    if (!session) throw new Error('no session');
    return session;
  };

  const googleOffered = async () =>
    (await openSession()).firstTouch?.coldStart?.googleOffered === true;

  const cardRows = () =>
    db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, INTAKE_GOOGLE_CARD_TEMPLATE_KEY));

  const failAuditWrites = async (action: string) => {
    await db.exec(`
      create or replace function before_lighting_fail() returns trigger as $$
      begin
        if new.action_taken = '${action}' then raise exception 'write failed'; end if;
        return new;
      end $$ language plpgsql;
      create trigger before_lighting_fail before insert on audit_log
        for each row execute function before_lighting_fail();
    `);
  };

  describe('1. a hand-off survives a failed write', () => {
    const handOffRows = () =>
      db.database
        .select({ id: schema.auditLog.id })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'onboarding_walk_handed_off'));

    const inboundOf = () =>
      db.database
        .select({ id: schema.channelMessages.id })
        .from(schema.channelMessages)
        .where(
          and(eq(schema.channelMessages.direction, 'in'), eq(schema.channelMessages.body, LEAVE)),
        );

    it('reaches the disconnect handler on the resend, and only once', async () => {
      const talk = conversation(db.database, readAs(LEAVE, 'disconnect_google'));
      for (const words of [...UP_TO_NAME, 'Dana', 'yes']) await talk.say(words);
      const { familyId, parentUserId } = await onlyFamily();
      await saveConnection(db.database, {
        familyId,
        userId: parentUserId,
        provider: 'gmail',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        tokens: { accessToken: 'ya29.test-access', refreshToken: '1//test-refresh' },
      });

      await failAuditWrites('onboarding_walk_handed_off');
      await expect(talk.say(LEAVE)).rejects.toThrow();
      expect(await inboundOf()).toEqual([]);
      await db.exec('drop trigger before_lighting_fail on audit_log');

      await talk.redeliver();

      const rows = await inboundOf();
      expect(rows).toHaveLength(1);
      expect(await handOffRows()).toHaveLength(1);
      expect(talk.enqueued.map((job) => job.channel_message_id)).toEqual([rows[0]?.id]);

      const handler = connectorDisconnectHandler(
        console,
        scriptedSaidLine(),
        ports,
        disconnectRead,
      );
      const ctx = {
        familyId,
        parentUserId,
        conversationId: '11111111-2222-4333-8444-555555555503',
        body: LEAVE,
        send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
        now: talk.now(),
        resolved: null,
        openQuestions: async () => [],
        inboundChannelMessageId: rows[0]?.id ?? null,
      };
      expect(await handler.detects(db.database, ctx)).toBe(true);
      expect(await handler.handle(db.database, ctx)).toMatchObject({
        claimed: true,
        outcome: 'revoked',
      });

      const callsBefore = talk.seen.length;
      const again = await talk.redeliver();

      expect(again.bodies).toEqual([]);
      expect(talk.seen).toHaveLength(callsBefore);
      expect(await inboundOf()).toHaveLength(1);
      expect(await handOffRows()).toHaveLength(1);
      expect(talk.enqueued).toHaveLength(1);
    });

    it('a resend of an ordinary walk turn is still a duplicate', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      const before = talk.transport.bodies().length;
      const callsBefore = talk.seen.length;

      await talk.redeliver();

      expect(talk.transport.bodies()).toHaveLength(before);
      expect(talk.seen).toHaveLength(callsBefore);
    });
  });

  describe('2. a claim that died is not a sent link', () => {
    it('says nothing about a link until one really went', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      const { familyId, parentUserId } = await onlyFamily();
      await db.database.insert(schema.channelMessages).values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'intake',
        templateKey: INTAKE_GOOGLE_CARD_TEMPLATE_KEY,
        dedupeKey: googleCardDedupeKey(familyId),
        status: 'failed',
        errorCode: 'send_in_flight',
        createdAt: talk.now(),
      });

      const named = await talk.say('Dana');

      expect(named.bodies).toEqual([]);
      expect(await googleOffered()).toBe(false);

      const answered = await talk.say('yes');

      expect(answered.bodies.filter((body) => /link is right there/i.test(body))).toEqual([]);
      expect(linksIn(talk.transport.bodies())).toEqual([]);
      expect(await googleOffered()).toBe(false);

      talk.advance(SIX_MINUTES);
      const later = await talk.say('hello?');

      expect(linksIn(later.bodies)).toHaveLength(1);
      expect(linksIn(later.bodies)[0]).toContain('to=google');
      expect(await googleOffered()).toBe(true);
    });

    /**
     * Linq as the card meets it: a key it already took drops the copy, and the first link send
     * never returns, standing in for a function that died after Linq took the words.
     */
    const linqWhoseFirstLinkHangs = (
      talk: ReturnType<typeof conversation>,
      hungLinkLanded: boolean,
    ) => {
      const real = talk.transport.send.bind(talk.transport);
      const taken = new Map<string, string>();
      const landed: string[] = [];
      const linkKeys: string[] = [];
      let hung = false;
      let reachedHang: () => void = () => undefined;
      const hangReached = new Promise<void>((resolve) => {
        reachedHang = resolve;
      });
      vi.spyOn(talk.transport, 'send').mockImplementation(async (input) => {
        const key = input.sendKey;
        if (key?.endsWith(':link')) linkKeys.push(key);
        const already = key ? taken.get(key) : undefined;
        if (already) return { providerMessageId: already };
        if (key?.endsWith(':link') && !hung) {
          hung = true;
          if (hungLinkLanded) {
            taken.set(key, 'linq-hung-link');
            landed.push(input.body);
          }
          reachedHang();
          return new Promise<never>(() => undefined);
        }
        const sent = await real(input);
        if (key) taken.set(key, sent.providerMessageId);
        landed.push(input.body);
        return sent;
      });
      return { landed, linkKeys, hangReached };
    };

    it('a card whose words went but whose link never did is not a sent link', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      const linq = linqWhoseFirstLinkHangs(talk, false);

      void talk.say('Dana');
      await linq.hangReached;
      const [crashed] = await cardRows();
      expect(crashed?.providerMessageId).toBeNull();
      expect(linksIn(linq.landed)).toEqual([]);

      const next = await talk.say('yes');
      expect(next.bodies.filter((body) => /link is right there/i.test(body))).toEqual([]);
      expect(await googleOffered()).toBe(false);
      const after = await talk.say('ok');
      expect(after.bodies.filter((body) => /link is right there/i.test(body))).toEqual([]);
      expect(linksIn(linq.landed)).toEqual([]);
      expect(await googleOffered()).toBe(false);

      talk.advance(SIX_MINUTES);
      await talk.say('hello?');

      expect(linksIn(linq.landed)).toHaveLength(1);
      expect(linksIn(linq.landed)[0]).toContain('to=google');
      expect(linq.linkKeys).toHaveLength(2);
      expect(linq.linkKeys[1]).toBe(linq.linkKeys[0]);
      expect(await googleOffered()).toBe(true);
      const [card] = await cardRows();
      expect(card?.providerMessageId).not.toBeNull();
    });

    it('retries a link that may have landed on its own key, so Linq drops the copy', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      const linq = linqWhoseFirstLinkHangs(talk, true);

      void talk.say('Dana');
      await linq.hangReached;
      talk.advance(SIX_MINUTES);
      await talk.say('hello?');

      expect(linq.linkKeys).toHaveLength(2);
      expect(linq.linkKeys[1]).toBe(linq.linkKeys[0]);
      expect(linksIn(linq.landed)).toHaveLength(1);
      expect(await googleOffered()).toBe(true);
      // The parent holds the link that landed, so the retry's fresh token must not kill it.
      const held = new URL(linksIn(linq.landed)[0] ?? '').searchParams.get('t');
      if (!held) throw new Error('the landed link carries no token');
      expect((await presentChannelSigninToken(held, db.database, { now: talk.now() })).ok).toBe(
        true,
      );
    });

    it('still reads a card Linq accepted as sent', async () => {
      const talk = conversation(db.database);
      for (const words of [...UP_TO_NAME, 'Dana']) await talk.say(words);

      expect(linksIn(talk.transport.bodies())).toHaveLength(1);
      expect(await googleOffered()).toBe(true);
    });
  });

  describe('3. what was said 1:1 stays out of a group turn', () => {
    const toHealth = [...UP_TO_ACTIVITIES, HEALTH_WORDS, 'Dana'];

    it('keeps a health activity out of the context and the fact slots', async () => {
      const talk = conversation(db.database, readsHealth);
      for (const words of toHealth) await talk.say(words);

      const oneToOne = await talk.say('what happens next?');
      const inOneToOne = oneToOne.inputs.at(-1);
      if (!inOneToOne) throw new Error('no 1:1 model input');
      expect(carriesHealth(inOneToOne)).toEqual({ context: true, slots: true });

      const group = await talk.say('what works for everyone?', { group: true });

      expect(group.inputs.length).toBeGreaterThan(0);
      for (const input of group.inputs) {
        expect(carriesHealth(input)).toEqual({ context: false, slots: false });
      }
    });

    it('keeps what was said in the group for the next group turn', async () => {
      const talk = conversation(db.database, readsHealth);
      for (const words of toHealth) await talk.say(words);
      const first = await talk.say('what works for everyone?', { group: true });
      expect(first.bodies.length).toBeGreaterThan(0);

      const second = await talk.say('and on the weekend?', { group: true });

      const turns = second.inputs.at(-1)?.recentTurns ?? [];
      expect(turns.map((turn) => turn.body)).toEqual([
        'what works for everyone?',
        first.bodies.at(-1),
      ]);
    });

    it('treats an older entry with no bit as not said in the group', async () => {
      const talk = conversation(db.database, readsHealth);
      for (const words of toHealth) await talk.say(words);
      const session = await openSession();
      await saveSession(
        db.database,
        session,
        { transcript: session.transcript.map(({ inGroup: _dropped, ...entry }) => entry) },
        talk.now(),
      );

      const group = await talk.say('what works for everyone?', { group: true });

      expect(group.inputs.at(-1)?.recentTurns).toEqual([]);
    });

    it('holds on the owed-map read of a group turn', async () => {
      const talk = conversation(db.database, readsHealth);
      for (const words of toHealth) await talk.say(words);
      const session = await openSession();
      const touch = session.firstTouch;
      if (!touch?.coldStart) throw new Error('no cold start');
      await saveSession(
        db.database,
        session,
        { firstTouch: { ...touch, coldStart: { ...touch.coldStart, findDelivered: false } } },
        talk.now(),
      );

      const group = await talk.say('what works for everyone?', { group: true });

      expect(group.inputs.map((input) => input.step)).toContain('find_show');
      for (const input of group.inputs) {
        expect(carriesHealth(input)).toEqual({ context: false, slots: false });
      }
    });

    it('holds in the help answer on a group turn', async () => {
      const talk = conversation(db.database, readsHealth);
      for (const words of toHealth) await talk.say(words);
      await saveSession(
        db.database,
        await openSession(),
        { state: 'awaiting_watch_reply' },
        talk.now(),
      );

      const group = await talk.say('what can you do?', { group: true });

      expect(group.inputs.map((input) => input.step)).toEqual(['help']);
      expect(carriesHealth(group.inputs[0] as FriendVoiceInput)).toEqual({
        context: false,
        slots: false,
      });
    });

    it('dark, a group turn still reads the whole transcript', async () => {
      vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');
      const talk = conversation(db.database);
      for (const words of ['hi', 'M5V 2T6', 'Maya', "she's 4", 'Dana']) await talk.say(words);

      const group = await talk.say('what works for everyone?', { group: true });

      expect(group.inputs.at(-1)?.recentTurns.map((turn) => turn.body)).toContain("she's 4");
      const stored = (await openSession()).transcript;
      expect(stored.filter((entry) => entry.direction === 'out' && 'inGroup' in entry)).toEqual([]);
    });
  });

  describe('4. no sign-in token in the thread', () => {
    const storedLinks = async () => {
      const rows = await db.database
        .select({ content: schema.messages.content })
        .from(schema.messages);
      return rows.map((row) => row.content).filter((content) => content.includes('/connect?'));
    };

    it.each([
      [
        'https://app.example.com/connect?t=abc_DEF-123&to=google',
        'https://app.example.com/connect?to=google',
      ],
      [
        'https://app.example.com/connect?to=gmail&t=abc_DEF-123',
        'https://app.example.com/connect?to=gmail',
      ],
      [
        'a https://app.example.com/connect?t=one&to=gcal b https://app.example.com/connect?t=two&to=gmail',
        'a https://app.example.com/connect?to=gcal b https://app.example.com/connect?to=gmail',
      ],
      [
        'https://classes.example/connect?t=registration-123&view=details',
        'https://classes.example/connect?t=registration-123&view=details',
      ],
      ['https://example.com/page?t=keep&to=me', 'https://example.com/page?t=keep&to=me'],
      ['https://app.example.com/connect?to=google', 'https://app.example.com/connect?to=google'],
    ])('reads %s as %s', (raw, kept) => {
      expect(withoutConnectTokens(raw)).toBe(kept);
    });

    it('stores the one Google card without its token', async () => {
      const talk = conversation(db.database);
      for (const words of [...UP_TO_NAME, 'Dana']) await talk.say(words);
      const wire = linksIn(talk.transport.bodies())[0];
      expect(wire).toMatch(TOKEN_PARAM);

      const stored = await storedLinks();

      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toMatch(TOKEN_PARAM);
      expect(stored[0]).toContain('/connect?to=google');
      expect(connectOfferTarget(stored[0] as string)).toBe('google');
    });

    it('stores a fresh Google link without its token', async () => {
      const talk = conversation(db.database);
      for (const words of [...UP_TO_NAME, 'Dana']) await talk.say(words);
      const { familyId, parentUserId } = await onlyFamily();
      await db.exec('delete from messages');

      const outcome = await textFreshConnectorLink(
        db.database,
        { familyId, parentUserId, provider: 'google', now: talk.now() },
        {
          transport: talk.transport,
          imessage: async () => ({ providerMessageId: 'linq-fresh' }),
          threadMessage: threadProactiveMessage,
          saidLine: scriptedSaidLine(),
        },
      );

      expect(outcome).toBe('sent');
      const stored = await storedLinks();
      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toMatch(TOKEN_PARAM);
      expect(connectOfferTarget(stored[0] as string)).toBe('google');
    });

    const perProviderCard = async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      const { familyId, parentUserId } = await onlyFamily();
      await db.exec('delete from messages');
      const cards = await sendYearConnectorCards(
        db.database,
        {
          familyId,
          parentUserId,
          phoneE164: PHONE,
          language: 'en',
          now: talk.now(),
          ridesReply: true,
          only: 'gmail',
          voice: { gmail: 'Gmail card prose (test fixture).' },
        },
        { transport: talk.transport, threadMessage: threadProactiveMessage },
      );
      expect(cards.gmail).toBe('sent');
      return storedLinks();
    };

    it('lit, stores a per-provider card without its token', async () => {
      const stored = await perProviderCard();

      expect(stored).toHaveLength(1);
      expect(stored[0]).not.toMatch(TOKEN_PARAM);
      expect(connectOfferTarget(stored[0] as string)).toBe('gmail');
    });

    it('dark, stores a per-provider card as it does today', async () => {
      vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');

      const stored = await perProviderCard();

      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatch(/\/connect\?t=[A-Za-z0-9_-]{20,}&to=gmail/);
    });
  });

  describe('4b. an edit webhook writes the same thread', () => {
    const EDITED_LINK = 'https://app.example.com/connect?t=abcdefghijklmnopqrstuv&to=google';

    it.each([
      ['the parent', 'user', 'in', 'inbound'],
      ['Hale', 'assistant', 'out', 'outbound'],
    ] as const)('lit, keeps no token from an edit by %s', async (_who, role, direction, wire) => {
      const { familyId, parentUserId } = await seedFamily(db.database);
      const [conversation] = await db.database
        .insert(schema.conversations)
        .values({ familyId })
        .returning({ id: schema.conversations.id });
      if (!conversation) throw new Error('no conversation');
      const messageId = '11111111-2222-4333-8444-555555555504';
      await db.database.insert(schema.messages).values({
        conversationId: conversation.id,
        role,
        content: 'before the edit',
        providerMessageId: messageId,
      });
      await db.database.insert(schema.channelMessages).values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction,
        category: 'reply',
        status: 'delivered',
        body: direction === 'in' ? 'before the edit' : null,
        providerMessageId: messageId,
        providerChatId: CHAT,
        relatedConversationId: conversation.id,
        sentAt: T0,
      });
      const edit = {
        messageId,
        chatId: CHAT,
        partIndex: 0,
        text: `here it is ${EDITED_LINK}`,
        editedAt: T0,
        direction: wire,
        isFromMe: wire === 'outbound',
      };

      expect(await recordLinqEditWebhook(db.database, edit)).toBe('updated');
      expect(await recordLinqEditWebhook(db.database, edit)).toBe('unchanged');

      const [row] = await db.database
        .select({ content: schema.messages.content })
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageId, messageId));
      expect(row?.content).toBe('here it is https://app.example.com/connect?to=google');
    });
  });

  describe('4c. an edit whose only change was its token', () => {
    const REDACTED = 'use this https://app.example.com/connect?to=google';
    const FRESH = 'use this https://app.example.com/connect?t=abcdefghijklmnopqrstuv&to=google';
    const OLDER = 'ignore this link';

    it.each([
      ['the parent', 'user', 'in', 'inbound'],
      ['Hale', 'assistant', 'out', 'outbound'],
    ] as const)('lit, still outranks an older edit by %s', async (_who, role, direction, wire) => {
      const { familyId, parentUserId } = await seedFamily(db.database);
      const [conversation] = await db.database
        .insert(schema.conversations)
        .values({ familyId })
        .returning({ id: schema.conversations.id });
      if (!conversation) throw new Error('no conversation');
      const messageId = '11111111-2222-4333-8444-555555555505';
      await db.database.insert(schema.messages).values({
        conversationId: conversation.id,
        role,
        content: REDACTED,
        providerMessageId: messageId,
      });
      await db.database.insert(schema.channelMessages).values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction,
        category: 'reply',
        status: 'delivered',
        body: direction === 'in' ? REDACTED : null,
        providerMessageId: messageId,
        providerChatId: CHAT,
        relatedConversationId: conversation.id,
        sentAt: T0,
      });
      const edit = (text: string, editedAt: Date) => ({
        messageId,
        chatId: CHAT,
        partIndex: 0,
        text,
        editedAt,
        direction: wire,
        isFromMe: wire === 'outbound',
      });
      const newer = edit(FRESH, new Date(T0.getTime() + 2_000));

      await recordLinqEditWebhook(db.database, newer);
      expect(await recordLinqEditWebhook(db.database, newer)).toBe('unchanged');
      const late = await recordLinqEditWebhook(
        db.database,
        edit(OLDER, new Date(T0.getTime() + 1_000)),
      );

      expect(late).toBe('unchanged');
      const [row] = await db.database
        .select({ content: schema.messages.content })
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageId, messageId));
      expect(row?.content).toBe(REDACTED);
    });
  });

  describe('5. a stop during an unclear link preview', () => {
    const stopDuringPreview = (talk: ReturnType<typeof conversation>, status: number) => {
      const previewKeys: string[] = [];
      talk.onFetch(async (url, init) => {
        if (!url.includes('/chats/') || init?.method !== 'POST') return null;
        const sent = JSON.parse(String(init.body)) as {
          message: { idempotency_key: string; parts: { type: string }[] };
        };
        if (sent.message.parts[0]?.type !== 'link') return null;
        previewKeys.push(sent.message.idempotency_key);
        await db.database.update(schema.parentChannels).set({ revokedAt: talk.now() });
        return Response.json({ error: { code: 5000 } }, { status });
      });
      return previewKeys;
    };

    it('keeps the key, sends nothing further, and is never retried on a new key', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      sendAsImessage(talk);
      const previewKeys = stopDuringPreview(talk, 502);

      const turn = await talk.say('Dana');

      expect(previewKeys).toHaveLength(1);
      expect(linksIn(turn.bodies)).toEqual([]);
      const [row] = await cardRows();
      const { familyId, parentUserId } = await onlyFamily();
      expect(row?.dedupeKey).toBe(googleCardDedupeKey(familyId));
      const unsent = await db.database
        .select({ after: schema.auditLog.after, audience: schema.auditLog.audience })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'google_connect_text_unsent'));
      expect(unsent).toEqual([
        { after: { surface: 'card', failure: 'unconfirmed' }, audience: parentUserId },
      ]);

      talk.onFetch(null);
      await db.database.update(schema.parentChannels).set({ revokedAt: null });
      const next = await talk.say('hello?');

      expect(linksIn(next.bodies)).toEqual([]);
      expect(previewKeys).toHaveLength(1);
      expect(await cardRows()).toHaveLength(1);
    });

    it('a certain refusal under the same stop still frees the key', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      sendAsImessage(talk);
      stopDuringPreview(talk, 400);

      const turn = await talk.say('Dana');

      expect(linksIn(turn.bodies)).toEqual([]);
      const [row] = await cardRows();
      expect(row?.dedupeKey).toBeNull();
    });

    it('reads a link send that threw as unclear, and keeps its key', async () => {
      const talk = conversation(db.database);
      for (const words of UP_TO_NAME) await talk.say(words);
      await db.exec(`
        create or replace function before_lighting_fail() returns trigger as $$
        begin
          if new.template_key = 'linq:link_text' then raise exception 'write failed'; end if;
          return new;
        end $$ language plpgsql;
        create trigger before_lighting_fail before insert on channel_messages
          for each row execute function before_lighting_fail();
      `);

      await talk.say('Dana');

      const { familyId, parentUserId } = await onlyFamily();
      const [row] = await cardRows();
      expect(row?.dedupeKey).toBe(googleCardDedupeKey(familyId));
      const unsent = await db.database
        .select({ after: schema.auditLog.after, audience: schema.auditLog.audience })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'google_connect_text_unsent'));
      expect(unsent).toEqual([
        { after: { surface: 'card', failure: 'unconfirmed' }, audience: parentUserId },
      ]);
    });
  });
});
