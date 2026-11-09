import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { runDeletionSweep } from '~/lib/rights/delete';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { handleLinqInboundRequest } from './inbound';

/**
 * `linq_shared_group_people` holds the numbers, first names and inferred kid names of
 * everyone Hale saw in a shared chat, non-customers included. A row is presence: it lives
 * while the person is in the chat and Hale is in the chat, and goes with the family on
 * erasure. Nothing here depends on the multi-family flag, which is dark in production.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+12025550100';
const PARENT_A = '+12025550111';
const PARENT_B = '+12025550122';
const GUEST = '+12025550133';
const CHAT = 'chat-shared';
const OTHER_CHAT = 'chat-other';
const NOW = new Date('2026-11-09T18:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = Buffer.alloc(32, 9);
const TS = String(Math.floor(NOW.getTime() / 1000));

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
  vi.stubEnv('LINQ_FROM_E164', HALE);
  // Production today: v2 and members on, multi-family dark.
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', '');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table linq_shared_group_people, families, users cascade');
});

async function seedFamily(options: { scheduledDeletionAt?: Date } = {}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Household',
      provinceOrState: 'NY',
      scheduledDeletionAt: options.scheduledDeletionAt,
    })
    .returning({ id: schema.families.id });
  return family?.id as string;
}

async function seedPresent(chatId: string, phone: string, familyId: string | null) {
  await db.database.insert(schema.linqSharedGroupPeople).values({
    chatId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    familyId,
    firstName: 'Sam',
    inferredKidName: 'Kid',
  });
}

async function present() {
  const rows = await db.database
    .select({
      chatId: schema.linqSharedGroupPeople.chatId,
      hash: schema.linqSharedGroupPeople.phoneE164Hash,
    })
    .from(schema.linqSharedGroupPeople);
  return rows.map((row) => `${row.chatId}:${row.hash}`).sort();
}

const at = (chatId: string, phone: string) => `${chatId}:${phoneBlindIndex(phone)}`;

function signed(body: unknown): Request {
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', SECRET_BYTES).update(`evt_people.${TS}.${raw}`).digest('base64');
  return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': 'evt_people',
      'webhook-timestamp': TS,
      'webhook-signature': `v1,${mac}`,
    },
    body: raw,
  });
}

function removed(handle: string, isMe: boolean) {
  return {
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'participant.removed',
    event_id: 'evt_people',
    created_at: NOW.toISOString(),
    data: {
      chat_id: CHAT,
      handle,
      participant: { handle, is_me: isMe, service: 'iMessage', status: 'removed' },
    },
  };
}

function deps() {
  return {
    database: db.database,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    enqueue: async () => {},
    now: () => NOW,
    groupVoice: fakeGroupOnboardingComposer(),
  } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
}

async function seedChat() {
  const familyA = await seedFamily();
  const familyB = await seedFamily();
  await seedPresent(CHAT, PARENT_A, familyA);
  await seedPresent(CHAT, PARENT_B, familyB);
  await seedPresent(CHAT, GUEST, null);
  await seedPresent(OTHER_CHAT, GUEST, null);
  return { familyA, familyB };
}

describe('shared-group presence rows', () => {
  it('a person taken out of the chat is forgotten there, and only there', async () => {
    await seedChat();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );

    await handleLinqInboundRequest(signed(removed(GUEST, false)), deps());

    // Positive control: the others in this chat, and the same number elsewhere, stay.
    expect(await present()).toEqual(
      [at(CHAT, PARENT_A), at(CHAT, PARENT_B), at(OTHER_CHAT, GUEST)].sort(),
    );
  });

  it('Hale taken out of the chat forgets everyone it saw there, and no other chat', async () => {
    await seedChat();
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetchMock);

    await handleLinqInboundRequest(signed(removed(HALE, true)), deps());

    expect(await present()).toEqual([at(OTHER_CHAT, GUEST)]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('erasing a family deletes its people rows; another family and a guest stay', async () => {
    const erased = await seedFamily({ scheduledDeletionAt: new Date(NOW.getTime() - DAY_MS) });
    const staying = await seedFamily();
    await seedPresent(CHAT, PARENT_A, erased);
    await seedPresent(CHAT, PARENT_B, staying);
    await seedPresent(CHAT, GUEST, null);

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(await present()).toEqual([at(CHAT, PARENT_B), at(CHAT, GUEST)].sort());
  });
});
