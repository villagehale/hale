import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { linqGroupPlanEnabled } from './config';
import {
  fakeGroupPlanFinder,
  fakeGroupPlanReader,
  followUpUnanswered,
  loadOpenPlan,
  loadPlanAnswers,
  takeGroupPlanTurn,
} from './group-plan';
import { handleLinqInboundRequest } from './inbound';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PRIYA = '+14165550111';
const JORDAN = '+14165550112';
const MEI = '+14165550113';
const SAM = '+14165550114';
const STRANGER = '+14165550999';
const FROM = '+16462352164';
const CHAT = 'chat-chen-household';
const NOW = new Date('2026-10-28T16:00:00.000Z');
const DEADLINE = new Date('2026-10-30T16:00:00.000Z');

const OPTIONS = [
  {
    id: '1',
    name: 'Saturday parent-and-tot swim',
    when: 'Saturdays 9:15am',
    where: 'Elm rec centre',
    price: '$8 drop-in',
    link: 'https://example.test/elm-swim',
  },
  {
    id: '2',
    name: 'Sunday family swim',
    when: 'Sundays 11am',
    where: 'Riverside pool',
    price: '$12',
    link: 'https://example.test/riverside',
  },
];

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_GROUP_PLAN_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('AI_GATEWAY_API_KEY', '');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('BROWSER_USE_API_KEY', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `preview-${texts.length}` };
  };
  return { send, texts };
}

async function seedChenHousehold() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Chen', provinceOrState: 'ON', linqGroupChatId: CHAT })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const people = [
    { phone: PRIYA, name: 'Priya Chen', role: 'parent' as const },
    { phone: JORDAN, name: 'Jordan Chen', role: 'co_parent' as const },
    { phone: MEI, name: 'Mei Chen', role: 'other_family' as const },
    { phone: SAM, name: 'Sam Rivera', role: 'caregiver' as const },
  ];
  const seated: { phone: string; userId: string; name: string }[] = [];
  for (const person of people) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `imessage:${person.phone}`, name: person.name })
      .returning({ id: schema.users.id });
    const userId = user?.id as string;
    await db.database.insert(schema.familyMembers).values({
      familyId,
      userId,
      role:
        person.role === 'parent'
          ? 'primary_parent'
          : person.role === 'co_parent'
            ? 'co_parent'
            : person.role === 'other_family'
              ? 'extended'
              : 'nanny',
    });
    await db.database.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(person.phone),
      phoneE164Hash: phoneBlindIndex(person.phone),
      verifiedAt: NOW,
    });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId,
      chatId: CHAT,
      userId,
      phoneE164Encrypted: encryptString(person.phone),
      phoneE164Hash: phoneBlindIndex(person.phone),
      role: person.role,
      seatedAt: NOW,
    });
    seated.push({ phone: person.phone, userId, name: person.name });
  }
  return { familyId, seated };
}

function readerForConversation() {
  return fakeGroupPlanReader(({ text, reactionType }) => {
    if (reactionType === 'like' || reactionType === 'love' || reactionType === 'emphasize') {
      return { intent: 'yes', optionId: '1', subject: null, confidence: 'high' };
    }
    if (reactionType === 'dislike') {
      return { intent: 'no', optionId: null, subject: null, confidence: 'high' };
    }
    if (reactionType === 'question') {
      return { intent: 'maybe', optionId: null, subject: null, confidence: 'high' };
    }
    const body = text.trim().toLowerCase();
    if (body.includes('find') || body.includes('what is on') || body.includes('quoi')) {
      return { intent: 'plan_ask', optionId: null, subject: 'saturday swim', confidence: 'high' };
    }
    if (body.includes('count us') || body.includes('on est partants') || body.includes('first one')) {
      return { intent: 'yes', optionId: '1', subject: null, confidence: 'high' };
    }
    if (body.includes('sunday') || body.includes('the other')) {
      return { intent: 'yes', optionId: '2', subject: null, confidence: 'high' };
    }
    if (body.includes('maybe') || body.includes('peut')) {
      return { intent: 'maybe', optionId: null, subject: null, confidence: 'high' };
    }
    if (body.includes('out') || body.includes('pass')) {
      return { intent: 'no', optionId: null, subject: null, confidence: 'high' };
    }
    if (body.includes('lol') || body.includes('haha')) {
      return { intent: 'chatter', optionId: null, subject: null, confidence: 'high' };
    }
    return { intent: 'unclear', optionId: null, subject: null, confidence: 'low' };
  });
}

describe('linqGroupPlanEnabled', () => {
  it('is off unless the flag is exactly true', () => {
    vi.stubEnv('LINQ_GROUP_PLAN_ENABLED', '');
    expect(linqGroupPlanEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_PLAN_ENABLED', 'true');
    expect(linqGroupPlanEnabled()).toBe(true);
  });
});

describe('VIL-441 plan together (pglite, keys unset)', () => {
  it('posts finder options, reads mixed answers, a mind-change, a maybe, and ignores a non-member', async () => {
    const { familyId } = await seedChenHousehold();
    const wire = sender();
    const reader = readerForConversation();
    const finder = fakeGroupPlanFinder(OPTIONS);

    const ask = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'Hale, can you find us a Saturday swim?',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(ask).toMatchObject({ handled: true, outcome: 'group_plan_posted', notice: 'sent' });
    expect(wire.texts[0]).toContain('Saturday parent-and-tot swim');
    expect(wire.texts[0]).toContain('https://example.test/elm-swim');

    const plan = await loadOpenPlan(db.database, CHAT);
    expect(plan?.familyId).toBe(familyId);
    expect(plan?.options).toHaveLength(2);

    const jordan = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: JORDAN,
      text: '',
      reactionType: 'like',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(jordan).toMatchObject({
      handled: true,
      outcome: 'group_plan_vote',
      seated: true,
      stance: 'yes',
      spoke: false,
    });

    const mei = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: MEI,
      text: 'maybe, depends on nap',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(mei).toMatchObject({ seated: true, stance: 'maybe', spoke: false });

    const stranger = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: STRANGER,
      text: 'count us in for the first one',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(stranger).toMatchObject({ seated: false, stance: 'yes', spoke: false });

    const changed = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: JORDAN,
      text: 'actually the Sunday one',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(changed).toMatchObject({ seated: true, stance: 'yes' });

    const answers = await loadPlanAnswers(db.database, plan?.id as string);
    const jordanRow = answers.find((row) => row.phoneE164Hash === phoneBlindIndex(JORDAN));
    expect(jordanRow?.optionId).toBe('2');
    const strangerRow = answers.find((row) => row.phoneE164Hash === phoneBlindIndex(STRANGER));
    expect(strangerRow?.seated).toBe('no');
    expect(answers.filter((row) => row.seated === 'yes')).toHaveLength(2);
    expect(wire.texts).toHaveLength(1);
  });

  it('stays quiet on chatter and on a low-confidence read', async () => {
    await seedChenHousehold();
    const wire = sender();
    const reader = readerForConversation();
    const finder = fakeGroupPlanFinder(OPTIONS);
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'Hale find us a Saturday swim',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    const chatter = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: JORDAN,
      text: 'haha lol',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(chatter).toEqual({ handled: false, outcome: 'not_a_plan_turn' });
    const unclear = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: JORDAN,
      text: 'hmm',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(unclear).toEqual({ handled: false, outcome: 'not_a_plan_turn' });
    expect(wire.texts).toHaveLength(1);
  });

  it('follows up once after the deadline, then never again', async () => {
    const { seated } = await seedChenHousehold();
    const wire = sender();
    const reader = readerForConversation();
    const finder = fakeGroupPlanFinder(OPTIONS);
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'Hale find us a Saturday swim',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: JORDAN,
      text: 'count us in for the first one',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    const afterDeadline = new Date(DEADLINE.getTime() + 60_000);
    const follow = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'any word?',
      ports: { now: afterDeadline, language: 'en', send: wire.send, reader, finder },
    });
    expect(follow).toMatchObject({ handled: true, outcome: 'group_plan_followed_up', notice: 'sent' });
    expect(wire.texts[1]).toMatch(/Mei|Sam/);
    const again = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'any word?',
      ports: { now: new Date(afterDeadline.getTime() + 60_000), language: 'en', send: wire.send, reader, finder },
    });
    expect(again.outcome).not.toBe('group_plan_followed_up');
    expect(wire.texts.filter((line) => line.includes('still thinking') || line.includes('Mei'))).toHaveLength(1);

    const plan = await loadOpenPlan(db.database, CHAT);
    const parent = seated[0];
    if (!plan || !parent) throw new Error('follow-up fixture missing plan or parent');
    const answers = await loadPlanAnswers(db.database, plan.id);
    const second = await followUpUnanswered(db.database, {
      plan,
      members: seated.map((row) => ({ userId: row.userId, name: row.name.split(' ')[0] ?? null })),
      answers,
      language: 'en',
      now: new Date(afterDeadline.getTime() + 120_000),
      send: wire.send,
      parentUserId: parent.userId,
    });
    expect(second.outcome).toBe('already_followed_up');
  });

  it('sends nothing when the finder is dark or the writer fails', async () => {
    await seedChenHousehold();
    const wire = sender();
    const reader = readerForConversation();
    const dark = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'Hale find us a Saturday swim',
      ports: {
        now: NOW,
        language: 'en',
        send: wire.send,
        reader,
        finder: fakeGroupPlanFinder({ found: false, reason: 'not_configured' }),
      },
    });
    expect(dark).toEqual({
      handled: true,
      outcome: 'group_plan_finder_unavailable',
      reason: 'not_configured',
    });
    expect(wire.texts).toEqual([]);
    expect(await loadOpenPlan(db.database, CHAT)).toBeNull();

    const silent = {
      async write() {
        return null;
      },
    };
    const { setSharedSpokenLineWriter } = await import('~/lib/channel/spoken-line');
    const { scriptedSpokenLineWriter } = await import('~/lib/testing/spoken-line.fixture');
    setSharedSpokenLineWriter(silent);
    try {
      const unsent = await takeGroupPlanTurn(db.database, {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: 'Hale find us a Saturday swim',
        ports: { now: NOW, language: 'en', send: wire.send, reader, finder: fakeGroupPlanFinder(OPTIONS) },
      });
      expect(unsent).toMatchObject({ handled: true, outcome: 'group_plan_posted', notice: 'model_unreachable' });
      expect(wire.texts).toEqual([]);
    } finally {
      setSharedSpokenLineWriter(scriptedSpokenLineWriter);
    }
  });

  it('speaks progress once everyone seated has answered, and writes an audit row', async () => {
    await seedChenHousehold();
    const wire = sender();
    const reader = readerForConversation();
    const finder = fakeGroupPlanFinder(OPTIONS);
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'Hale find us a Saturday swim',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: PRIYA,
      text: 'count us in for the first one',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: JORDAN,
      text: 'count us in for the first one',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: MEI,
      text: 'maybe',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    const last = await takeGroupPlanTurn(db.database, {
      chatId: CHAT,
      senderHandle: SAM,
      text: 'count us in for the first one',
      ports: { now: NOW, language: 'en', send: wire.send, reader, finder },
    });
    expect(last).toMatchObject({ handled: true, outcome: 'group_plan_progress', spoke: true });
    expect(wire.texts.at(-1)).toContain('Saturday parent-and-tot swim');
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_settled'));
    expect(audits).toHaveLength(1);
  });
});

describe('VIL-441 inbound before/after (flag off vs on)', () => {
  const KEY_BYTES = Buffer.alloc(32, 9);
  const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
  const API_KEY = 'linq_test_key_not_a_secret';
  const TS = String(Math.floor(NOW.getTime() / 1000));

  function signed(body: unknown): Request {
    const raw = JSON.stringify(body);
    const mac = createHmac('sha256', KEY_BYTES).update(`evt_plan.${TS}.${raw}`).digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_plan',
        'webhook-timestamp': TS,
        'webhook-signature': `v1,${mac}`,
      },
      body: raw,
    });
  }

  function groupText(sender: string, text: string) {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt_plan',
      created_at: NOW.toISOString(),
      data: {
        chat: { id: CHAT, is_group: true },
        id: 'msg-plan-1',
        direction: 'inbound',
        sender_handle: { handle: sender, is_me: false },
        parts: [{ type: 'text', value: text }],
        sent_at: NOW.toISOString(),
        service: 'iMessage',
      },
    };
  }

  function door(sends: string[], intake?: () => never) {
    return {
      database: db.database,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      enqueue: async () => {},
      now: () => NOW,
      intake:
        intake ??
        (() => {
          throw new Error('inbound reached the 1:1 intake; the plan door should have answered');
        }),
      groupPlanReader: readerForConversation(),
      groupPlanFinder: fakeGroupPlanFinder(OPTIONS),
      sendGroupText: async (input: { chatId: string; text: string }) => {
        sends.push(input.text);
        return { providerMessageId: `in-${sends.length}` };
      },
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    vi.stubEnv('LINQ_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('LINQ_FROM_E164', FROM);
  });

  it('BEFORE: flag off, the same ask never posts options', async () => {
    await seedChenHousehold();
    vi.stubEnv('LINQ_GROUP_PLAN_ENABLED', '');
    expect(linqGroupPlanEnabled()).toBe(false);
    const sends: string[] = [];
    await expect(
      handleLinqInboundRequest(
        signed(groupText(PRIYA, 'Hale, can you find us a Saturday swim?')),
        door(sends, () => {
          throw new Error('flag-off inbound continued past the plan door');
        }),
      ),
    ).rejects.toThrow('flag-off inbound continued past the plan door');
    expect(sends).toEqual([]);
    expect(await loadOpenPlan(db.database, CHAT)).toBeNull();
  });

  it('AFTER: flag on, a seated parent ask posts finder options through inbound', async () => {
    await seedChenHousehold();
    vi.stubEnv('LINQ_GROUP_PLAN_ENABLED', 'true');
    const sends: string[] = [];
    const response = await handleLinqInboundRequest(
      signed(groupText(PRIYA, 'Hale, can you find us a Saturday swim?')),
      door(sends),
    );
    expect(await response.json()).toMatchObject({
      outcome: 'group_plan_posted',
      notice: 'sent',
    });
    expect(sends[0]).toContain('Saturday parent-and-tot swim');
    expect(await loadOpenPlan(db.database, CHAT)).not.toBeNull();
  });
});
