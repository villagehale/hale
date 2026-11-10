import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { linqChatBlindIndex, phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { HALE_CONTACT_FIRST_NAME, shareHaleContactCardOnce } from './contact-card';

/**
 * The share audit row is immutable and in every adult's copy, so it names the chat by its
 * keyed index. The once-a-day read matches by that key, and by the raw id an older row
 * carries.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-09-24T12:00:00.000Z');
const DAY = '2026-09-24';
const CHAT = 'chat-one-to-one';
const OTHER = 'chat-another-one-to-one';

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
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', '+15555550100');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function liveCardFetch() {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('/contact_card?') || init?.method === 'GET') {
      return Response.json({
        contact_cards: [
          { phone_number: '+15555550100', first_name: HALE_CONTACT_FIRST_NAME, is_active: true },
        ],
      });
    }
    if (target.endsWith('/contact_card')) {
      return Response.json({ is_active: true, phone_number: '+15555550100' }, { status: 201 });
    }
    return new Response(null, { status: 200 });
  });
}

async function enrolled() {
  const family = await seedFamily(db.database);
  await db.database.insert(schema.parentChannels).values({
    userId: family.parentUserId,
    familyId: family.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString('+15555550101'),
    phoneE164Hash: phoneBlindIndex('+15555550101'),
    verifiedAt: NOW,
  });
  return family;
}

function share(family: { familyId: string; parentUserId: string }, chatId: string) {
  return shareHaleContactCardOnce(db.database, {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    chatId,
    channel: 'imessage',
    isGroup: false,
    now: NOW,
    fetch: liveCardFetch(),
  });
}

async function shareRows(familyId: string) {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'linq_contact_card_shared'),
      ),
    );
}

/** A row another day's share wrote; the channel stamp is cleared so only the audit decides. */
async function priorShare(
  family: { familyId: string; parentUserId: string },
  after: Record<string, unknown>,
) {
  await db.database.insert(schema.auditLog).values({
    familyId: family.familyId,
    actor: family.parentUserId,
    actionTaken: 'linq_contact_card_shared',
    targetTable: 'parent_channels',
    targetId: family.familyId,
    occurredAt: NOW,
    after,
  });
}

describe('Linq contact card share audit', () => {
  it('names the chat by its key, never the raw chat id', async () => {
    const family = await enrolled();
    expect(await share(family, CHAT)).toEqual({ status: 'shared' });
    expect(await shareRows(family.familyId)).toEqual([
      {
        after: {
          outcome: 'shared',
          firstName: HALE_CONTACT_FIRST_NAME,
          chatKey: linqChatBlindIndex(CHAT),
          sharedOn: DAY,
        },
      },
    ]);
  });

  it('a keyed row holds that chat for the day and leaves another chat free', async () => {
    const family = await enrolled();
    await priorShare(family, {
      outcome: 'shared',
      chatKey: linqChatBlindIndex(CHAT),
      sharedOn: DAY,
    });
    expect(await share(family, CHAT)).toEqual({ status: 'not_sent', reason: 'already_shared' });
    expect(await share(family, OTHER)).toEqual({ status: 'shared' });
  });

  it('an older row with the raw chat id still holds that chat, and only that chat', async () => {
    const family = await enrolled();
    await priorShare(family, { outcome: 'shared', chatId: CHAT, sharedOn: DAY });
    expect(await share(family, CHAT)).toEqual({ status: 'not_sent', reason: 'already_shared' });
    expect(await share(family, OTHER)).toEqual({ status: 'shared' });
  });
});
