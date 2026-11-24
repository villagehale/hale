import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelMessageReceivedJob,
  type InboundRouteDeps,
  routeInboundText,
} from '~/lib/channel/inbound-route';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { scriptedFriendVoice } from '~/lib/channel/intake/scripted-friend-voice.fixture';
import {
  createChatReplyTransport,
  createOutboundTransport,
} from '~/lib/channel/outbound-transport';
import { setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { askWriter, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';
import type {
  AddThemYourselfComposed,
  AddThemYourselfRequest,
  AddThemYourselfVoice,
} from './add-them-yourself';

/**
 * ADD_COMMAND_NO_COLD_TEXT_ENABLED, through the real inbound turn: Linq's door hands the
 * text to `routeInboundText`, the intake machine routes it, and the real Linq transports
 * post through `fetch`. Only `fetch` and the model's composers are scripted.
 *
 * Hale never texts a number first. A parent who asks Hale to add someone gets one
 * model-written reply in their own chat saying how that person gets in, and the number
 * they named is never texted, looked up, or handed to the model.
 */

const FLAG = 'ADD_COMMAND_NO_COLD_TEXT_ENABLED';
const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const PERSON_PHONE = '+16475550199';
const OTHER_PHONE = '+14165550122';
const PERSON_DIGITS = /647\D?555\D?0199|6475550199/;
const LINE = '+16475550100';
const PARENT_CHAT = 'chat-parent-1';
const OPS_WEBHOOK = 'https://ops.example.test/hook';
const NOW = new Date('2026-11-24T15:00:00.000Z');
const ADD_CO_PARENT = 'add Sam 647-555-0199 as my partner';
const ADD_CAREGIVER = 'add grandma 647-555-0199 as grandparent';
const REPLY =
  'I never text anyone first. Add them to your family group with me in it, or have them text me.';

type LinqPost = { method: string; path: string; to: string[] | null; text: string | null };

let db: TestDb;
let posts: LinqPost[];
let pages: string[];
let jobs: ChannelMessageReceivedJob[];
let threaded: string[];
let logged: string[];
let composed: AddThemYourselfRequest[];
let inboundCount = 0;

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
        method: init?.method ?? 'GET',
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

function scriptedVoice(result: AddThemYourselfComposed): AddThemYourselfVoice {
  return {
    async compose(request) {
      composed.push(request);
      return result;
    },
  };
}

let voice: AddThemYourselfVoice;

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
  jobs = [];
  threaded = [];
  logged = [];
  composed = [];
  voice = scriptedVoice({ status: 'composed', body: REPLY });
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', LINE);
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', OPS_WEBHOOK);
  vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
  vi.stubEnv(FLAG, 'true');
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
      );
    });
  }
  stubFetch();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function seedFamilyWith(
  phone: string,
  name: string,
): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: `${name} + kids`,
      onboardingStage: 'sms_active',
      country: 'CA',
      provinceOrState: 'ON',
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

function intakeDeps(transport: 'imessage' | 'sms', chatId: string | null): IntakeDeps {
  return {
    transport:
      transport === 'imessage'
        ? createChatReplyTransport({ chatId, replyToMessageId: null })
        : createOutboundTransport(),
    threadMessage: async (_db, input) => {
      threaded.push(input.body);
      return 'conv-1';
    },
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    friendVoice: scriptedFriendVoice,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    consent: yesNoReader(),
    consentAsk: askWriter(),
    addThemYourself: voice,
    now: NOW,
  } as IntakeDeps;
}

function routeDeps(): InboundRouteDeps {
  return {
    database: db.database,
    intake: (inboundTransport, linq) =>
      intakeDeps(inboundTransport === 'imessage' ? 'imessage' : 'sms', linq?.chatId ?? null),
    enqueue: async (job) => {
      jobs.push(job);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => NOW,
  };
}

async function parentSays(body: string, channel: 'imessage' | 'sms') {
  inboundCount += 1;
  return routeInboundText(routeDeps(), {
    from: PARENT_PHONE,
    body,
    providerId: `in-parent-${inboundCount}`,
    receivedAt: NOW,
    transport: channel,
    ...(channel === 'imessage' ? { chatId: PARENT_CHAT, isGroup: false } : {}),
  });
}

async function inviteRows(): Promise<Array<{ state: string }>> {
  return db.database.select({ state: schema.caregiverInvites.state }).from(schema.caregiverInvites);
}

/** Every message Linq was asked to deliver. The typing dots in the parent's chat are not one. */
function messages(): LinqPost[] {
  return posts.filter((post) => !post.path.endsWith('/typing'));
}

function sendsToParent(channel: 'imessage' | 'sms'): LinqPost[] {
  return channel === 'imessage'
    ? posts.filter((post) => post.path === `/chats/${PARENT_CHAT}/messages`)
    : posts.filter((post) => post.path === '/chats' && post.to?.[0] === PARENT_PHONE);
}

function sendsTouchingThePerson(): LinqPost[] {
  return posts.filter(
    (post) => post.to?.includes(PERSON_PHONE) === true || PERSON_DIGITS.test(post.text ?? ''),
  );
}

async function auditText(): Promise<string> {
  const rows = await db.database.select().from(schema.auditLog);
  return JSON.stringify(rows);
}

const CASES = [
  { who: 'a co-parent', body: ADD_CO_PARENT, name: 'Sam', role: 'co_parent' },
  { who: 'a caregiver', body: ADD_CAREGIVER, name: 'grandma', role: 'grandparent' },
] as const;

describe('flag on: the add command texts nobody but the parent', () => {
  for (const channel of ['imessage', 'sms'] as const) {
    for (const each of CASES) {
      it(`${each.who} on ${channel}: one reply in the parent's own chat, nothing to the number, no invite`, async () => {
        await seedFamilyWith(PARENT_PHONE, 'Ana');

        const outcome = await parentSays(each.body, channel);

        expect(outcome).toBe('intake');
        expect(messages()).toHaveLength(1);
        expect(sendsToParent(channel)).toEqual([expect.objectContaining({ text: REPLY })]);
        expect(sendsTouchingThePerson()).toEqual([]);
        expect(await inviteRows()).toEqual([]);
        expect(threaded).toEqual([REPLY]);
        expect(composed).toEqual([{ language: 'en', name: each.name, role: each.role, channel }]);
        expect(JSON.stringify(composed)).not.toMatch(/\d{3}/);
        expect(await auditText()).not.toMatch(PERSON_DIGITS);
        expect(logged.join('\n')).not.toMatch(PERSON_DIGITS);
        expect(jobs).toEqual([]);
      });
    }
  }

  it('looks nothing up about the number: an account or an open invite elsewhere changes nothing', async () => {
    const replyFor = async (seedElsewhere: () => Promise<void>) => {
      await db.exec('truncate table families, users, rate_limits cascade');
      composed = [];
      posts = [];
      await seedElsewhere();
      await seedFamilyWith(PARENT_PHONE, 'Ana');
      const outcome = await parentSays(ADD_CAREGIVER, 'sms');
      return { outcome, composed: [...composed], texts: messages().map((p) => [p.to, p.text]) };
    };

    const unknownNumber = await replyFor(async () => {});
    const hasAnAccount = await replyFor(async () => {
      await seedFamilyWith(PERSON_PHONE, 'Lee');
    });
    const invitedElsewhere = await replyFor(async () => {
      const other = await seedFamilyWith(OTHER_PHONE, 'Lee');
      await db.database.insert(schema.caregiverInvites).values({
        familyId: other.familyId,
        invitedByUserId: other.parentUserId,
        role: 'grandparent',
        displayName: 'Pat',
        phoneE164Encrypted: encryptString(PERSON_PHONE),
        phoneE164Hash: phoneBlindIndex(PERSON_PHONE),
        state: 'awaiting_parent_assent',
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      });
    });

    expect(unknownNumber).toEqual({
      outcome: 'intake',
      composed: [{ language: 'en', name: 'grandma', role: 'grandparent', channel: 'sms' }],
      texts: [[[PARENT_PHONE], REPLY]],
    });
    expect(hasAnAccount).toEqual(unknownNumber);
    expect(invitedElsewhere).toEqual(unknownNumber);
  });

  it('positive control, flag off: the same account is looked up and refused, and an invite opens for a new number', async () => {
    vi.stubEnv(FLAG, '');
    await seedFamilyWith(PERSON_PHONE, 'Lee');
    await seedFamilyWith(PARENT_PHONE, 'Ana');
    await parentSays(ADD_CAREGIVER, 'sms');
    expect(composed).toEqual([]);
    expect(await inviteRows()).toEqual([]);

    await db.exec('truncate table families, users, rate_limits cascade');
    await seedFamilyWith(PARENT_PHONE, 'Ana');
    await parentSays(ADD_CAREGIVER, 'sms');
    expect(composed).toEqual([]);
    expect(await inviteRows()).toEqual([{ state: 'awaiting_parent_assent' }]);
  });
});

describe('flag on: a reply the model cannot write', () => {
  it('sends nothing, pages #ops without the number, and is named intake_unsent', async () => {
    voice = scriptedVoice({ status: 'unsent', reason: 'model_failed' });
    await seedFamilyWith(PARENT_PHONE, 'Ana');

    const outcome = await parentSays(ADD_CO_PARENT, 'imessage');

    expect(outcome).toBe('intake_unsent');
    expect(messages()).toEqual([]);
    expect(threaded).toEqual([]);
    expect(await inviteRows()).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('add_them_yourself_unwritten');
    expect(pages[0]).toContain('model_failed');
    expect(pages[0]).not.toMatch(PERSON_DIGITS);
    expect(logged.join('\n')).not.toMatch(PERSON_DIGITS);
  });

  it('positive control: a written reply pages nobody', async () => {
    await seedFamilyWith(PARENT_PHONE, 'Ana');
    await parentSays(ADD_CO_PARENT, 'imessage');
    expect(pages).toEqual([]);
    expect(sendsToParent('imessage')).toHaveLength(1);
  });
});

describe('flag on: a bare yes afterwards', () => {
  it('sends nothing to anyone and goes to the coach as an ordinary text', async () => {
    const seeded = await seedFamilyWith(PARENT_PHONE, 'Ana');
    await parentSays(ADD_CAREGIVER, 'sms');
    posts = [];

    const outcome = await parentSays('yes', 'sms');

    expect(outcome).toBe('handed_off');
    expect(messages()).toEqual([]);
    expect(jobs).toEqual([expect.objectContaining({ parent_user_id: seeded.parentUserId })]);
    expect(await inviteRows()).toEqual([]);
  });

  it('never sends an invite that was opened before the flag was lit; it is left to lapse', async () => {
    vi.stubEnv(FLAG, '');
    await seedFamilyWith(PARENT_PHONE, 'Ana');
    await parentSays(ADD_CAREGIVER, 'sms');
    expect(await inviteRows()).toEqual([{ state: 'awaiting_parent_assent' }]);

    vi.stubEnv(FLAG, 'true');
    posts = [];
    const outcome = await parentSays('yes', 'sms');

    expect(outcome).toBe('handed_off');
    expect(messages()).toEqual([]);
    expect(await inviteRows()).toEqual([{ state: 'awaiting_parent_assent' }]);
  });

  it('positive control, flag off: the same yes texts the named number', async () => {
    vi.stubEnv(FLAG, '');
    await seedFamilyWith(PARENT_PHONE, 'Ana');
    await parentSays(ADD_CAREGIVER, 'sms');
    posts = [];

    await parentSays('yes', 'sms');

    expect(sendsTouchingThePerson().length).toBeGreaterThan(0);
    expect(await inviteRows()).toEqual([{ state: 'awaiting_caregiver_reply' }]);
  });
});

describe('the flag', () => {
  it('is on only for the exact value true', async () => {
    for (const value of ['TRUE', ' true', 'true\n', '1', 'on']) {
      vi.stubEnv(FLAG, value);
      await seedFamilyWith(PARENT_PHONE, 'Ana');
      composed = [];
      await parentSays(ADD_CAREGIVER, 'sms');
      expect(composed, JSON.stringify(value)).toEqual([]);
      await db.exec('truncate table families, users, rate_limits cascade');
    }
  });
});
