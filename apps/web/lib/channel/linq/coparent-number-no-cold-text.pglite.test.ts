import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AddThemYourselfComposed,
  AddThemYourselfRequest,
  AddThemYourselfVoice,
} from '~/lib/channel/caregiver/add-them-yourself';
import { INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { createDisambiguationStore } from '~/lib/channel/router/disambiguation';
import { createReplyTransport } from '~/lib/channel/router/reply-transport';
import { type ChannelRouterDeps, routeChannelMessage } from '~/lib/channel/router/route';
import { darkSideTurn } from '~/lib/channel/router/side-turn.fixture';
import {
  auditSmokeAlarmClaim,
  auditTurnLedger,
  defaultHandlers,
  defaultOpenQuestionReader,
  loadInboundContext,
} from '~/lib/channel/router/wiring';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { calendarOffersIdle } from '~/lib/integrations/calendar-offer-read';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { quietAckEtaPorts } from '~/lib/testing/ack-eta-ports';
import { askWriter, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';

/**
 * ADD_COMMAND_NO_COLD_TEXT_ENABLED at the co-parent number door, through the real router
 * turn: the production handler chain and the production reply transport, with only
 * `fetch` and the model's composers scripted.
 *
 * A number sent after the co-parent ask is answered in the parent's own chat with how
 * that person gets in. The number is never texted, on either channel.
 */

const FLAG = 'ADD_COMMAND_NO_COLD_TEXT_ENABLED';
const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const COPARENT_PHONE = '+19055550182';
const COPARENT_DIGITS = /905\D?555\D?0182|9055550182/;
const LINE = '+16475550100';
const CHAT = 'chat-parent-1';
const OPS_WEBHOOK = 'https://ops.example.test/hook';
const NOW = new Date('2026-11-24T15:00:00.000Z');
const REPLY =
  'I never text anyone first. Add Sam to your family group with me in it, or have Sam text me.';
const COACH = 'coach reply';

type LinqPost = { path: string; to: string[] | null; text: string | null };

let db: TestDb;
let posts: LinqPost[];
let pages: string[];
let composed: AddThemYourselfRequest[];
let voiceResult: AddThemYourselfComposed;
let inboundCount = 0;

const voice: AddThemYourselfVoice = {
  async compose(request) {
    composed.push(request);
    return voiceResult;
  },
};

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === OPS_WEBHOOK) {
        pages.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return new Response('ok', { status: 200 });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const message = body.message as { parts?: Array<{ value?: string }> } | undefined;
      const path = new URL(href).pathname.replace(/^.*\/v3/, '');
      posts.push({
        path,
        to: Array.isArray(body.to) ? (body.to as string[]) : null,
        text: message?.parts?.[0]?.value ?? null,
      });
      const id = `out-${posts.length}`;
      const payload =
        path === '/chats'
          ? { chat: { id: `chat-new-${posts.length}`, message: { id } } }
          : { message: { id } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  posts = [];
  pages = [];
  composed = [];
  voiceResult = { status: 'composed', body: REPLY };
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', LINE);
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', OPS_WEBHOOK);
  vi.stubEnv(FLAG, 'true');
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  stubFetch();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

function deps(): ChannelRouterDeps {
  return {
    database: db.database,
    loadContext: loadInboundContext,
    transport: createReplyTransport({ phone: createOutboundTransport() }),
    handlers: defaultHandlers({
      consent: yesNoReader(),
      ask: askWriter(),
      addThemYourself: voice,
    }),
    questions: defaultOpenQuestionReader(),
    offDomain: { consider: async () => ({ status: 'in_domain', fallback: null }) },
    coach: {
      async respond() {
        return { reply: COACH, planOffer: null, activityPromise: null, spotWatch: null };
      },
    },
    smokeAlarm: auditSmokeAlarmClaim(db.database),
    turns: auditTurnLedger(db.database),
    burst: { plan: async () => ({ kind: 'lone', waitedMs: 0, why: 'flag_off' }) },
    sideTurn: darkSideTurn(),
    apology: { compose: async () => ({ status: 'composed', reply: 'sorry' }) },
    holdingLine: { compose: async () => ({ status: 'composed', line: 'on it' }) },
    holdingTapback: { compose: async () => ({ status: 'composed', reaction: { type: 'like' } }) },
    ackEta: quietAckEtaPorts(),
    sendParentReaction: async () => ({ status: 'sent' }),
    floodLine: { compose: async () => ({ status: 'composed', line: 'busy' }) },
    recordPlanOffer: async () => ({ status: 'recorded' }),
    recordCapabilityNotes: async () => ({ status: 'recorded', declined: 0, corrected: 0 }),
    recordActivityPromise: async () => ({
      status: 'recorded',
      commitmentId: '77777777-7777-4777-8777-777777777777',
    }),
    replyResolver: { read: async () => ({ status: 'unresolved', reason: 'no_target' }) },
    calendarOffers: calendarOffersIdle,
    weekdayCareReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    schoolBreakReplyReader: { read: async () => ({ status: 'nothing_stated' as const }) },
    recordSchoolBreak: async () => {},
    disambiguation: createDisambiguationStore(),
    reconcileView: loadReconcileView,
    claimShadow: { coachTurn: () => 'off', sweep: () => 'off', dispatch: () => 'off' },
    claimEnforcer: {
      enforces: () => false,
      read: async () => {
        throw new Error('the claim reader is not enforced here');
      },
    },
    recordStatedState: async () => ({ status: 'nothing_stated' }),
    weekdayCareAnswerTarget: async () => ({ status: 'no_open_ask' as const }),
    searchWeekdays: async () => ({ status: 'abstain' as const, reason: 'not_configured' }),
    recordWeekdayCare: async (_db, input) => ({
      status: 'recorded' as const,
      care: input.care,
      providerNamed: input.provider !== null,
    }),
    recordRegistrationWatch: async () => ({ status: 'recorded' }),
    armWatchedSpot: async () => ({ status: 'armed', spotId: 'spot-1' }),
    dispatchDeepResearch: async () => ({ status: 'enqueued' }),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: () => NOW,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function seedAskedHousehold(
  channel: 'imessage' | 'sms',
): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(db.database, 'Ana + kids');
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel,
    direction: 'out',
    category: 'reply',
    templateKey: INTAKE_COPARENT_ASK_TEMPLATE_KEY,
    providerMessageId: `ask-${channel}`,
    providerChatId: channel === 'imessage' ? CHAT : null,
    status: 'delivered',
    sentAt: new Date(NOW.getTime() - 60_000),
    createdAt: new Date(NOW.getTime() - 60_000),
  });
  return seeded;
}

async function parentSends(
  seeded: { familyId: string; parentUserId: string },
  channel: 'imessage' | 'sms',
  body: string,
) {
  inboundCount += 1;
  const providerMessageId = `in-${channel}-${inboundCount}`;
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel,
      direction: 'in',
      category: 'reply',
      providerMessageId,
      providerChatId: channel === 'imessage' ? CHAT : null,
      status: 'delivered',
      body,
      createdAt: NOW,
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  return routeChannelMessage(deps(), {
    family_id: seeded.familyId,
    parent_user_id: seeded.parentUserId,
    channel_message_id: row?.id as string,
    provider_message_id: providerMessageId,
    received_at: NOW.toISOString(),
    in_group: false,
  });
}

function messages(): LinqPost[] {
  return posts.filter((post) => !post.path.endsWith('/typing'));
}

function toTheCoParent(): LinqPost[] {
  return posts.filter(
    (post) => post.to?.includes(COPARENT_PHONE) === true || COPARENT_DIGITS.test(post.text ?? ''),
  );
}

async function inviteRows(): Promise<Array<{ state: string }>> {
  return db.database.select({ state: schema.caregiverInvites.state }).from(schema.caregiverInvites);
}

describe('flag on: a number after the co-parent ask texts nobody but the parent', () => {
  it('on SMS: one reply to the parent, nothing to the number, no invite', async () => {
    const seeded = await seedAskedHousehold('sms');

    const result = await parentSends(seeded, 'sms', 'Sam 905-555-0182');

    expect(result.handler).toBe('co_parent_number');
    expect(messages()).toEqual([{ path: '/chats', to: [PARENT_PHONE], text: REPLY }]);
    expect(toTheCoParent()).toEqual([]);
    expect(await inviteRows()).toEqual([]);
    expect(composed).toEqual([{ language: 'en', name: 'Sam', role: 'co_parent', channel: 'sms' }]);
  });

  it("on iMessage: one reply in the parent's own chat, nothing to the number", async () => {
    const seeded = await seedAskedHousehold('imessage');

    const result = await parentSends(seeded, 'imessage', '9055550182');

    expect(result.handler).toBe('co_parent_number');
    expect(messages()).toEqual([{ path: `/chats/${CHAT}/messages`, to: null, text: REPLY }]);
    expect(toTheCoParent()).toEqual([]);
    expect(await inviteRows()).toEqual([]);
    expect(composed).toEqual([
      { language: 'en', name: null, role: 'co_parent', channel: 'imessage' },
    ]);
  });

  it('a reply the model cannot write sends nothing and pages #ops without the number', async () => {
    voiceResult = { status: 'unsent', reason: 'unusable' };
    const seeded = await seedAskedHousehold('sms');

    await parentSends(seeded, 'sms', 'Sam 905-555-0182');

    expect(messages()).toEqual([]);
    expect(await inviteRows()).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('add_them_yourself_unwritten');
    expect(pages[0]).not.toMatch(COPARENT_DIGITS);
  });

  it('positive control, flag off: the same SMS number texts the co-parent', async () => {
    vi.stubEnv(FLAG, '');
    const seeded = await seedAskedHousehold('sms');

    await parentSends(seeded, 'sms', 'Sam 905-555-0182');

    expect(toTheCoParent()).toEqual([
      expect.objectContaining({ path: '/chats', to: [COPARENT_PHONE] }),
    ]);
    expect(composed).toEqual([]);
  });
});
