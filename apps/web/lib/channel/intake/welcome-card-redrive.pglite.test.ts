import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { FakeTransport } from './transport';
import {
  WELCOME_CARD_REDRIVE_HOUR_LOCAL,
  isWelcomeCardRedriveSlot,
  runWelcomeCardRedrive,
} from './welcome-card-redrive';
import {
  CONTACT_CARD_URL,
  WELCOME_CARD_BODY,
  WELCOME_CARD_TEMPLATE_KEY,
  welcomeCardDedupeKey,
} from './welcome-card';

/**
 * The card a family who onboarded at night never got (VIL-355 follow-up · item 4).
 *
 * Against the real DDL because every claim here is a database one: "exactly one send"
 * is the partial unique index on `dedupe_key`, and "held for a different reason is not
 * re-driven" is a status filter that a hand-rolled fake would answer with whatever rows
 * it was handed.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** 2026-09-16, 08:12 in America/Toronto (EDT, UTC-4). */
const MORNING_0812 = new Date('2026-09-16T12:12:00.000Z');
/** 08:59 local — the same HOUR, a late cron tick. */
const MORNING_0859 = new Date('2026-09-16T12:59:00.000Z');
/** 07:45 local — before the window opens. */
const MORNING_0745 = new Date('2026-09-16T11:45:00.000Z');
/** The night the card was held: 22:36 local the evening before. */
const HELD_AT = new Date('2026-09-16T02:36:00.000Z');

let db: TestDb;
let households = 0;

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
  await db.exec('truncate table families, users cascade');
});

interface Household {
  familyId: string;
  parentUserId: string;
  phone: string;
}

async function seedHousehold(timezone = 'America/Toronto'): Promise<Household> {
  households += 1;
  const phone = `+1416555${3000 + households}`;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Night arrival', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:redrive-${households}`, name: 'Ana', timezone })
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
    verifiedAt: HELD_AT,
  });
  return { familyId, parentUserId, phone };
}

/** The receipt `sendWelcomeContactCard` writes when quiet hours hold the card. */
async function seedHeldCard(
  household: Household,
  status: 'suppressed_quiet_hours' | 'suppressed_cap' = 'suppressed_quiet_hours',
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: household.familyId,
    parentUserId: household.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'intake',
    templateKey: WELCOME_CARD_TEMPLATE_KEY,
    dedupeKey: null,
    status,
    createdAt: HELD_AT,
  });
}

function deps(transport: FakeTransport) {
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  return {
    threaded,
    deps: {
      ports: {
        transport,
        threadMessage: async (
          _db: unknown,
          input: { familyId: string; parentUserId: string; body: string },
        ) => {
          threaded.push(input);
          return 'conv-1';
        },
      },
    },
  };
}

async function cardRows(familyId: string) {
  return db.database
    .select({
      id: schema.channelMessages.id,
      status: schema.channelMessages.status,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, familyId),
        eq(schema.channelMessages.templateKey, WELCOME_CARD_TEMPLATE_KEY),
      ),
    );
}

describe('the 08:00 re-drive of a contact card quiet hours held', () => {
  it('matches the whole 08:00 local HOUR, not the minute the cron happens to fire', () => {
    expect(WELCOME_CARD_REDRIVE_HOUR_LOCAL).toBe(8);
    expect(isWelcomeCardRedriveSlot(MORNING_0812, 'America/Toronto')).toBe(true);
    expect(isWelcomeCardRedriveSlot(MORNING_0859, 'America/Toronto')).toBe(true);
    expect(isWelcomeCardRedriveSlot(MORNING_0745, 'America/Toronto')).toBe(false);
    // The parent's OWN clock: 08:12 Toronto is 05:12 in Vancouver.
    expect(isWelcomeCardRedriveSlot(MORNING_0812, 'America/Vancouver')).toBe(false);
  });

  it('sends the held card exactly once at the 08:00 tick, on the same key and verb', async () => {
    const household = await seedHousehold();
    await seedHeldCard(household);
    const transport = new FakeTransport();
    const { deps: runDeps, threaded } = deps(transport);

    const first = await runWelcomeCardRedrive(db.database, runDeps, MORNING_0812);

    expect(first).toMatchObject({ due: 1, sent: 1, alreadySent: 0, noSendTarget: 0 });
    expect(transport.sent).toEqual([
      { to: household.phone, body: WELCOME_CARD_BODY, mediaUrls: [CONTACT_CARD_URL] },
    ]);
    expect(threaded).toEqual([
      { familyId: household.familyId, parentUserId: household.parentUserId, body: WELCOME_CARD_BODY },
    ]);
    const rows = await cardRows(household.familyId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.dedupeKey === welcomeCardDedupeKey(household.familyId))).toEqual([
      expect.objectContaining({ status: 'queued' }),
    ]);
    // Rule #6: the same audit verb the intake-time send writes, on the same table.
    const audits = await db.database
      .select({
        actionTaken: schema.auditLog.actionTaken,
        targetTable: schema.auditLog.targetTable,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, household.familyId));
    expect(audits).toEqual([
      { actionTaken: 'sms_intake_contact_card', targetTable: 'channel_messages' },
    ]);

    // A SECOND tick in the same hour finds nothing owed — the key is spent, so the
    // family drops out of the selector before any send is attempted.
    const second = await runWelcomeCardRedrive(db.database, runDeps, MORNING_0859);
    expect(second).toMatchObject({ held: 0, due: 0, sent: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(await cardRows(household.familyId)).toHaveLength(2);
  });

  it('leaves alone a family that already has its card, and one held for another reason', async () => {
    // The two families this sweep must NOT touch, beside one it must — an absence
    // assertion with no positive control passes just as well on a sweep that is broken.
    const carded = await seedHousehold();
    await seedHeldCard(carded);
    await db.database.insert(schema.channelMessages).values({
      familyId: carded.familyId,
      parentUserId: carded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: WELCOME_CARD_TEMPLATE_KEY,
      dedupeKey: welcomeCardDedupeKey(carded.familyId),
      status: 'delivered',
      sentAt: HELD_AT,
      createdAt: HELD_AT,
    });
    const capped = await seedHousehold();
    await seedHeldCard(capped, 'suppressed_cap');
    const owed = await seedHousehold();
    await seedHeldCard(owed);
    const transport = new FakeTransport();

    const result = await runWelcomeCardRedrive(db.database, deps(transport).deps, MORNING_0812);

    expect(result).toMatchObject({ held: 1, due: 1, sent: 1 });
    expect(transport.sent.map((s) => s.to)).toEqual([owed.phone]);
  });

  it('leaves a card older than the re-drive window where it is', async () => {
    const household = await seedHousehold();
    await seedHeldCard(household);
    const transport = new FakeTransport();
    const threeWeeksOn = new Date(MORNING_0812.getTime() + 21 * 24 * 3_600_000);

    const result = await runWelcomeCardRedrive(db.database, deps(transport).deps, threeWeeksOn);

    expect(result).toMatchObject({ held: 0, due: 0, sent: 0 });
    expect(transport.sent).toEqual([]);
  });

  it('waits for the parent’s own 08:00 rather than the server’s', async () => {
    const toronto = await seedHousehold('America/Toronto');
    const vancouver = await seedHousehold('America/Vancouver');
    await seedHeldCard(toronto);
    await seedHeldCard(vancouver);
    const transport = new FakeTransport();

    const result = await runWelcomeCardRedrive(db.database, deps(transport).deps, MORNING_0812);

    expect(result).toMatchObject({ held: 2, due: 1, sent: 1 });
    expect(transport.sent.map((s) => s.to)).toEqual([toronto.phone]);
  });

  it('names a held card with no sendable number instead of dropping it silently', async () => {
    const household = await seedHousehold();
    await seedHeldCard(household);
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: HELD_AT })
      .where(eq(schema.parentChannels.userId, household.parentUserId));
    const transport = new FakeTransport();

    const result = await runWelcomeCardRedrive(db.database, deps(transport).deps, MORNING_0812);

    expect(result).toMatchObject({ due: 1, sent: 0, noSendTarget: 1 });
    expect(transport.sent).toEqual([]);
    // Nothing was claimed, so the card is still owed if they ever re-enroll.
    expect(await cardRows(household.familyId)).toHaveLength(1);
  });
});
