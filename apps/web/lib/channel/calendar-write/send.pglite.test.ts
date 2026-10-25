import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { productionCalendarWriteNoticePorts } from './send';

/**
 * VIL-454 (T6) 2/3 against a real database: the production gate holds an opted-out
 * parent and a quiet-hours send, and reading the event for a create or an update
 * writes nothing anywhere.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const MORNING = new Date('2026-09-16T14:12:00.000Z'); // 10:12 Toronto
const NIGHT = new Date('2026-09-17T03:12:00.000Z'); // 23:12 Toronto

let db: TestDb;
let n = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seed() {
  n += 1;
  const phone = `+1416555${8100 + n}`;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [parent] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:cwn-${n}`,
      name: 'Ana',
      timezone: 'America/Toronto',
      locale: 'en',
    })
    .returning({ id: schema.users.id });
  const parentUserId = parent?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: MORNING,
  });
  await recordWatchConsent(
    db.database,
    {
      familyId,
      userId: parentUserId,
      granted: true,
      verbatimReply: 'yes',
      interpretation: 'the parent said yes to being watched',
      channelMessageId: null,
    },
    MORNING,
  );
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'Swim lesson',
      startsAt: new Date('2026-09-19T14:00:00.000Z'),
      location: 'Community pool',
      source: 'parent',
      createdBy: parentUserId,
    })
    .returning({ id: schema.familyEvents.id });
  return { familyId, parentUserId, familyEventId: event?.id as string };
}

/** Every public table's row count plus the event row itself: a write anywhere shows. */
async function snapshot(familyEventId: string) {
  const tables = (await db.database.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const r = (await db.database.execute(
      sql.raw(`select count(*)::int as c from "${table_name}"`),
    )) as unknown as { rows: Array<{ c: number }> };
    counts[table_name] = r.rows[0]?.c ?? 0;
  }
  const [event] = await db.database
    .select()
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, familyEventId));
  return { counts, event };
}

describe('VIL-454 production notice ports, real database', () => {
  it('lets a send through for an enrolled parent in the daytime', async () => {
    const s = await seed();
    const ports = productionCalendarWriteNoticePorts(db.database);
    expect(await ports.gate(s.familyId, s.parentUserId, MORNING)).toMatchObject({ allowed: true });
  });

  it('holds an opted-out parent (STOP revoked the channel)', async () => {
    const s = await seed();
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: MORNING })
      .where(eq(schema.parentChannels.userId, s.parentUserId));
    const ports = productionCalendarWriteNoticePorts(db.database);
    expect(await ports.gate(s.familyId, s.parentUserId, MORNING)).toEqual({
      allowed: false,
      reason: 'not_enrolled',
    });
  });

  it('holds a send in quiet hours', async () => {
    const s = await seed();
    const ports = productionCalendarWriteNoticePorts(db.database);
    expect(await ports.gate(s.familyId, s.parentUserId, NIGHT)).toEqual({
      allowed: false,
      reason: 'quiet_hours',
    });
  });

  for (const op of ['create', 'update'] as const) {
    it(`reads the event for a ${op} without writing anything`, async () => {
      const s = await seed();
      const ports = productionCalendarWriteNoticePorts(db.database);
      const before = await snapshot(s.familyEventId);
      const loaded = await ports.loadEvent({
        familyId: s.familyId,
        familyEventId: s.familyEventId,
        op,
        actorUserId: s.parentUserId,
      });
      expect(loaded?.event.title).toEqual(expect.any(String));
      expect(loaded?.event.where).toBeNull();
      expect(await snapshot(s.familyEventId)).toEqual(before);
    });
  }
});
