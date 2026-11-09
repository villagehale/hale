import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { CapturedLinqCall, GroupCaptureSink } from './preview-linq-capture';

/**
 * VIL-444 · Devin 🟥: the Preview fake-group door reaches fake households only. A chat id
 * held by a real family, or a 437-555 number verified on a family with any real number,
 * is refused before anything is stored or routed into the group handler.
 */

const handleLinqGroupMessage = vi.fn(async () => Response.json({ ok: true }));
vi.mock('~/lib/channel/linq/inbound', () => ({
  handleLinqGroupMessage: (...args: unknown[]) => handleLinqGroupMessage(...(args as [])),
}));

const { handlePreviewFakeGroupInbound, MAX_FAKE_GROUP_TEXT } = await import(
  './preview-fake-group-inbound'
);

const KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 's3cret';
const ENV = {
  VERCEL_ENV: 'preview',
  PREVIEW_CAPTURE_TRANSPORT: 'on',
  PREVIEW_CAPTURE_GROUPS: 'on',
  PREVIEW_FAKE_INBOUND_SECRET: SECRET,
};
const FAKE_A = '+14375550142';
const FAKE_B = '+14375550143';
const REAL = '+14165550142';
const CHAT = 'preview-chat-household-1';

let t: TestDb;
let calls: CapturedLinqCall[];
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  t = await createTestDb();
}, 120_000);
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  for (const name of ['LINQ_API_KEY', 'LINQ_FROM_E164', 'LINQ_WEBHOOK_SECRET']) {
    vi.stubEnv(name, '');
  }
  calls = [];
  handleLinqGroupMessage.mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.exec('truncate table families, users cascade');
});

const sink: GroupCaptureSink = {
  async record(call) {
    calls.push(call);
  },
  async chatOfMessage() {
    return null;
  },
  async handlesOf() {
    return null;
  },
} as GroupCaptureSink;

let n = 0;
async function family(phones: string[], chatId: string | null = null) {
  const [row] = await t.database
    .insert(schema.families)
    .values({ displayName: 'Household', provinceOrState: 'ON', linqGroupChatId: chatId })
    .returning({ id: schema.families.id });
  const familyId = row?.id as string;
  for (const [i, phone] of phones.entries()) {
    n += 1;
    const [user] = await t.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:group-door-${n}`, name: 'Parent' })
      .returning({ id: schema.users.id });
    const userId = user?.id as string;
    await t.database
      .insert(schema.familyMembers)
      .values({ familyId, userId, role: i === 0 ? 'primary_parent' : 'co_parent' });
    await t.database.insert(schema.parentChannels).values({
      userId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: new Date('2026-07-01T00:00:00Z'),
    });
  }
  return familyId;
}

function post(body: Record<string, unknown>) {
  return handlePreviewFakeGroupInbound(
    new Request('https://preview.example/api/channels/preview/group-inbound', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: CHAT, from: FAKE_A, participants: [FAKE_A, FAKE_B], ...body }),
    }),
    {
      env: ENV,
      database: t.database,
      groupSink: sink,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
    } as never,
  );
}

describe('preview fake group door reaches fake households only', () => {
  it('routes a group whose every reachable family is all 437-555', async () => {
    await family([FAKE_A, FAKE_B], CHAT);
    const res = await post({ text: 'who has Maya at 4?' });
    expect(res.status).toBe(200);
    expect(handleLinqGroupMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses a fake chat id a real household holds, and stores nothing', async () => {
    await family([FAKE_A, FAKE_B]);
    await family([REAL], CHAT);
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'household_not_fake' });
    expect(calls).toEqual([]);
    expect(handleLinqGroupMessage).not.toHaveBeenCalled();
  });

  it('refuses a chat id on a real household roster', async () => {
    const real = await family([REAL]);
    await t.database.insert(schema.linqGroupRosters).values({
      chatId: CHAT,
      familyId: real,
      source: 'new_group',
      status: 'roles_proposed',
    });
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(handleLinqGroupMessage).not.toHaveBeenCalled();
  });

  it('refuses a 437-555 number verified on a family that also has a real number', async () => {
    await family([FAKE_A, REAL]);
    const res = await post({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(handleLinqGroupMessage).not.toHaveBeenCalled();
  });

  it('refuses text past the size cap before storing it', async () => {
    await family([FAKE_A, FAKE_B], CHAT);
    const res = await post({ text: 'x'.repeat(MAX_FAKE_GROUP_TEXT + 1) });
    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
    expect(handleLinqGroupMessage).not.toHaveBeenCalled();
  });
});
