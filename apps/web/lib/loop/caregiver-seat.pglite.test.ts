import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeChannel, fakeRenderer } from '~/lib/channel/fakes';
import { threadIfParent } from '~/lib/channel/thread';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { defaultReminderRunDeps } from '~/lib/loop/reminders/run';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { selectCaregiverSeats } from './caregiver-audience';

/**
 * What the DATABASE says a caregiver seat is — against the real DDL, because every claim
 * here is one a fake would answer yes to with the predicate deleted.
 *
 * Three subjects, one boot: who the loop may address (the audience join), where what it
 * says to them is written down (the thread guard, asked through the PRODUCTION binding),
 * and what a due reminder row knows about its own recipient. All three are the same
 * question asked of `family_members` + `parent_channels`, and pglite costs a boot per file.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const GRANDMA_PHONE = '+16475550199';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

let n = 0;

async function seedHousehold(): Promise<{ familyId: string; parentUserId: string }> {
  n += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:parent-${n}`, name: 'Ana' })
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
    phoneE164Encrypted: encryptString(`+1416555${String(1000 + n)}`),
    phoneE164Hash: phoneBlindIndex(`+1416555${String(1000 + n)}`),
    verifiedAt: new Date(),
  });
  return { familyId, parentUserId };
}

/** The rows `acceptInvite` writes, in the shapes it writes them. */
async function seatGrandma(
  familyId: string,
  opts: { member?: boolean; verified?: boolean; revoked?: boolean; timezone?: string } = {},
): Promise<string> {
  n += 1;
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:grandma-${n}`,
      email: null,
      name: null,
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  if (opts.member !== false) {
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId, role: 'grandparent' });
  }
  const phone = `${GRANDMA_PHONE.slice(0, -2)}${String(10 + n).slice(-2)}`;
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: opts.verified === false ? null : new Date(),
    revokedAt: opts.revoked ? new Date() : null,
  });
  return userId;
}

describe('selectCaregiverSeats — the three conditions, against the real rows', () => {
  it('returns an accepted grandparent with a verified live channel, on her own clock', async () => {
    const { familyId } = await seedHousehold();
    const userId = await seatGrandma(familyId, { timezone: 'America/Vancouver' });

    expect(await selectCaregiverSeats(db.database)).toEqual([
      { familyId, userId, role: 'grandparent', timezone: 'America/Vancouver', weekStartDay: 0 },
    ]);
  });

  it('drops her the moment her channel is revoked — which is what her STOP does', async () => {
    const { familyId } = await seedHousehold();
    await seatGrandma(familyId, { revoked: true });
    expect(await selectCaregiverSeats(db.database)).toEqual([]);
  });

  it('drops a channel that was never verified', async () => {
    const { familyId } = await seedHousehold();
    await seatGrandma(familyId, { verified: false });
    expect(await selectCaregiverSeats(db.database)).toEqual([]);
  });

  it('drops a number with no membership — an invite nobody ever accepted', async () => {
    const { familyId } = await seedHousehold();
    await seatGrandma(familyId, { member: false });
    expect(await selectCaregiverSeats(db.database)).toEqual([]);
  });

  it('never returns a parent, however enrolled they are', async () => {
    await seedHousehold();
    expect(await selectCaregiverSeats(db.database)).toEqual([]);
  });

  it('separates two households (the seat carries its own family)', async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    await seatGrandma(a.familyId);
    await seatGrandma(b.familyId);
    const seats = await selectCaregiverSeats(db.database);
    expect(new Set(seats.map((s) => s.familyId))).toEqual(new Set([a.familyId, b.familyId]));
  });
});

describe('threadIfParent — whose transcript a proactive text lands in', () => {
  async function conversationCount(familyId: string): Promise<number> {
    const rows = await db.database
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.familyId, familyId));
    return rows.length;
  }

  it("threads a parent's message into their own text thread (positive control)", async () => {
    const { familyId, parentUserId } = await seedHousehold();
    const outcome = await threadIfParent(db.database, {
      familyId,
      parentUserId,
      body: 'Hale: your week - Tue 4:15 Gymnastics',
    });
    expect(outcome.threaded).toBe(true);
    expect(await conversationCount(familyId)).toBe(1);
  });

  it('refuses a caregiver by name, and mints her no conversation inside the family', async () => {
    const { familyId } = await seedHousehold();
    const grandmaId = await seatGrandma(familyId);
    const outcome = await threadIfParent(db.database, {
      familyId,
      parentUserId: grandmaId,
      body: 'Hale: this week for Mia - Tue 4:15 Gymnastics',
    });
    expect(outcome).toEqual({ threaded: false, reason: 'recipient_not_parent' });
    expect(await conversationCount(familyId)).toBe(0);
  });

  it('refuses someone who holds no seat in the family at all', async () => {
    const a = await seedHousehold();
    const b = await seedHousehold();
    const outcome = await threadIfParent(db.database, {
      familyId: a.familyId,
      parentUserId: b.parentUserId,
      body: 'not yours',
    });
    expect(outcome).toEqual({ threaded: false, reason: 'recipient_not_parent' });
    expect(await conversationCount(a.familyId)).toBe(0);
  });

  /**
   * THROUGH THE PRODUCTION BINDING, not the function. Every other test here calls
   * `threadIfParent` directly and every journey test injects its own `threadMessage`, so
   * the one line that decides which writer the real dispatch holds — `buildDispatchPorts`
   * in channel/wiring.ts — was pinned by nothing: reverting it to the unguarded
   * `threadProactiveMessage` left the whole suite green while production minted a
   * grandmother a coach thread inside somebody else's family.
   */
  describe('buildDispatchPorts().threadMessage — the writer the real dispatch holds', () => {
    const ports = () =>
      buildDispatchPorts(db.database, {
        channels: { sms: fakeChannel('sms') },
        renderer: fakeRenderer,
      });

    it("threads a parent's proactive text (positive control)", async () => {
      const { familyId, parentUserId } = await seedHousehold();
      await ports().threadMessage({
        familyId,
        parentUserId,
        body: 'Hale: your week - Tue 4:15 Gymnastics',
      });
      expect(await conversationCount(familyId)).toBe(1);
    });

    it('mints a caregiver no conversation in the household she helps with', async () => {
      const { familyId } = await seedHousehold();
      const grandmaId = await seatGrandma(familyId);
      await ports().threadMessage({
        familyId,
        parentUserId: grandmaId,
        body: 'Hale: this week for Mia - Tue 4:15 Gymnastics',
      });
      expect(await conversationCount(familyId)).toBe(0);
    });
  });
});

/**
 * The fire gate's own facts, read the way production reads them.
 *
 * `smsChannelActive` is what a caregiver's STOP takes away, and the run asks the ROW for
 * it rather than a fan-out list — so the join that computes it is the whole guarantee,
 * and a fake answering `true` proves nothing about it.
 */
describe('defaultReminderRunDeps().loadDueReminders — what a due row knows about its recipient', () => {
  const NOW = new Date('2026-07-25T13:00:00Z');

  async function seedDueRow(familyId: string, userId: string): Promise<string> {
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId,
        title: 'Swim class',
        startsAt: new Date('2026-07-25T14:00:00Z'),
        source: 'placement',
      })
      .returning({ id: schema.familyEvents.id });
    const [reminder] = await db.database
      .insert(schema.eventReminders)
      .values({
        familyId,
        eventRef: event?.id as string,
        parentUserId: userId,
        offset: '-PT1H',
        fireAt: new Date('2026-07-25T13:00:00Z'),
        status: 'scheduled',
      })
      .returning({ id: schema.eventReminders.id });
    return reminder?.id as string;
  }

  it('says a seated grandparent with a live number is a grandparent whose channel is active', async () => {
    const { familyId } = await seedHousehold();
    const grandmaId = await seatGrandma(familyId);
    await seedDueRow(familyId, grandmaId);

    const rows = await defaultReminderRunDeps().loadDueReminders(db.database, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'grandparent', smsChannelActive: true });
  });

  it('says her channel is inactive once it is revoked — the row carries her STOP', async () => {
    const { familyId } = await seedHousehold();
    const grandmaId = await seatGrandma(familyId, { revoked: true });
    await seedDueRow(familyId, grandmaId);

    const rows = await defaultReminderRunDeps().loadDueReminders(db.database, NOW);
    expect(rows[0]).toMatchObject({ role: 'grandparent', smsChannelActive: false });
  });

  it('says her channel is inactive while it is unverified', async () => {
    const { familyId } = await seedHousehold();
    const grandmaId = await seatGrandma(familyId, { verified: false });
    await seedDueRow(familyId, grandmaId);

    const rows = await defaultReminderRunDeps().loadDueReminders(db.database, NOW);
    expect(rows[0]?.smsChannelActive).toBe(false);
  });

  it('carries a null role for a recipient whose membership is gone (a departed co-parent)', async () => {
    const { familyId, parentUserId } = await seedHousehold();
    await seedDueRow(familyId, parentUserId);
    // What `coparent/depart.ts` does, and all it does: the seat goes, the due row stays.
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, parentUserId));

    const rows = await defaultReminderRunDeps().loadDueReminders(db.database, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBeNull();
  });

  it('returns ONE row per reminder however many channels its recipient has held', async () => {
    // The join is the fan-out risk: a revoked row plus a live one for the same user must
    // not double the reminder (and double the text).
    const { familyId } = await seedHousehold();
    const grandmaId = await seatGrandma(familyId);
    await db.database.insert(schema.parentChannels).values({
      userId: grandmaId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString('+16475550100'),
      phoneE164Hash: phoneBlindIndex('+16475550100'),
      verifiedAt: new Date(),
      revokedAt: new Date(),
    });
    await seedDueRow(familyId, grandmaId);

    const rows = await defaultReminderRunDeps().loadDueReminders(db.database, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.smsChannelActive).toBe(true);
  });
});
