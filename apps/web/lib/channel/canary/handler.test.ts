import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { CANARY_PHONE_E164 } from './config';
import { inboundCanaryHandler } from './handler';
import type { HandlerContext } from '../router/route';

/**
 * The last handler in the chain, over the real tables.
 *
 * It is the far side of the write-side canary: the cron's verification reads
 * the audit row this writes, so "claimed" is not the assertion — the row is.
 * A handler answering `reply: null` leaves NO ledger trace of its own
 * (deliver() returns before claimAnswer), which is exactly why the row has to
 * be written here and why its absence must turn the canary red.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const NOW = new Date('2026-09-09T12:00:00.000Z');
const INBOUND_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';

let db: TestDb;
let canary: { familyId: string; parentUserId: string };
let stranger: { familyId: string; parentUserId: string };

/** The canary household as the seed script builds it: a family, a parent, and
 * one ACTIVE verified SMS channel on the synthetic probe number. */
async function seedCanaryHousehold(database: Database): Promise<void> {
  await database.insert(schema.parentChannels).values({
    userId: canary.parentUserId,
    familyId: canary.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
    phoneE164Hash: phoneBlindIndex(CANARY_PHONE_E164),
    verifiedAt: NOW,
  });
}

function turn(
  body: string,
  household: { familyId: string; parentUserId: string },
  openQuestions: () => Promise<never[]>,
): HandlerContext {
  return {
    familyId: household.familyId,
    parentUserId: household.parentUserId,
    conversationId: '66666666-6666-4666-8666-666666666666',
    body,
    now: NOW,
    send: async () => {
      throw new Error('the canary answers for itself — it must never send');
    },
    resolved: null,
    openQuestions,
    inboundChannelMessageId: INBOUND_MESSAGE_ID,
  };
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
  canary = await seedFamily(db.database, 'Hale inbound canary');
  stranger = await seedFamily(db.database, 'A real household');
}, 120_000);

afterAll(async () => {
  process.env.APP_ENCRYPTION_KEY = '';
  await db.close();
});

beforeEach(async () => {
  await db.database.delete(schema.auditLog);
  await db.database.delete(schema.parentChannels);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inboundCanaryHandler', () => {
  it('claims the probe turn, answers for itself, and leaves exactly one audit row', async () => {
    await seedCanaryHousehold(db.database);
    const openQuestions = vi.fn(async () => [] as never[]);

    const verdict = await inboundCanaryHandler().handle(
      db.database,
      turn('CANARY', canary, openQuestions),
    );

    expect(verdict).toEqual({ claimed: true, outcome: 'canary_answered', reply: null });
    // The reader chain GATE 2b would consult, walked on every tick: the canary
    // is only worth its rows if it runs the code a real turn runs.
    expect(openQuestions).toHaveBeenCalledTimes(1);

    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, canary.familyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: canary.parentUserId,
      actionTaken: 'sms_canary_answered',
      targetTable: 'channel_messages',
      targetId: INBOUND_MESSAGE_ID,
    });
  });

  it('reads the body the way a handset sends it — spacing and case are not the gate', async () => {
    await seedCanaryHousehold(db.database);

    const verdict = await inboundCanaryHandler().handle(
      db.database,
      turn('  canary ', canary, async () => []),
    );

    expect(verdict.claimed).toBe(true);
  });

  it('does NOT claim the word from another household — the family is half the gate', async () => {
    await seedCanaryHousehold(db.database);

    const verdict = await inboundCanaryHandler().handle(
      db.database,
      turn('CANARY', stranger, async () => []),
    );

    // A real parent typing "canary" reaches the coach like any other sentence.
    expect(verdict).toEqual({ claimed: false });
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('does NOT claim another word from the canary household — the body is the other half', async () => {
    await seedCanaryHousehold(db.database);

    const verdict = await inboundCanaryHandler().handle(
      db.database,
      turn('how do I register for swim?', canary, async () => []),
    );

    expect(verdict).toEqual({ claimed: false });
  });

  it('costs a REAL turn nothing: a non-probe body never reaches the database', async () => {
    await seedCanaryHousehold(db.database);
    // The identity lookup runs on the blind index, and the chain is walked for
    // every inbound text in the product. The body is checked first so the
    // overwhelming majority of turns pay no query at all.
    const query = vi.spyOn(db.client, 'query');

    await inboundCanaryHandler().handle(db.database, turn('yes', canary, async () => []));

    expect(query).not.toHaveBeenCalled();
  });

  it('declines when the canary channel is revoked — an unseeded probe claims nothing', async () => {
    await seedCanaryHousehold(db.database);
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: NOW })
      .where(eq(schema.parentChannels.familyId, canary.familyId));

    const verdict = await inboundCanaryHandler().handle(
      db.database,
      turn('CANARY', canary, async () => []),
    );

    expect(verdict).toEqual({ claimed: false });
  });
});
