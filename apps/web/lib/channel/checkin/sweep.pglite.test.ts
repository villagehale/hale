import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { F14_ENABLED_ENV } from '~/lib/channel/f14';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { CHECK_IN_ASK_TEMPLATE_KEY } from './copy';
import { type EveningCheckInDeps, defaultEveningCheckInDeps, runEveningCheckInSweep } from './sweep';

/**
 * The evening sweep through its OWN production wiring, against real Postgres.
 *
 * sweep.test.ts injects `selectFamilies` and `loadNamableChildren`, which means it can
 * never fail on a bug inside either — and both hold a promise the feature is judged on.
 * Deleting the teen filter out of `readNamableChildren` (rule #1) or joining the co-parent
 * instead of the primary parent left all 150 of those tests green. This file is the pin on
 * the two readers themselves, plus the three independent rails that stop a second text the
 * same evening.
 */

/** 20:17 Toronto, which is 17:17 in Vancouver. */
const TORONTO_EVENING = new Date('2026-07-06T00:17:00.000Z');
/** Three hours on: 20:17 Vancouver, 23:17 Toronto. */
const VANCOUVER_EVENING = new Date('2026-07-06T03:17:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  process.env[F14_ENABLED_ENV] = 'true';
});

afterAll(async () => {
  delete process.env[F14_ENABLED_ENV];
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

/**
 * Postgres stamps `created_at` with the real wall clock while the sweep runs on an
 * injected one, so a ledger row written under a fake evening looks minutes old rather
 * than months. In production those two clocks are the same instant — this puts them back
 * together, so the frequency cap's window is measured against the evening the message
 * actually went out rather than against the moment the test ran.
 */
async function alignLedgerToSendClock(): Promise<void> {
  await db.exec('update channel_messages set created_at = sent_at where sent_at is not null');
}

async function seedFamily(input: {
  primaryTz: string;
  coParentTz?: string;
  stage?: 'sms_active' | 'pending_invite';
  scheduledDeletionAt?: Date;
  children?: Array<{ name: string; dateOfBirth: string }>;
}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Ana + kids',
      provinceOrState: 'ON',
      onboardingStage: input.stage ?? 'sms_active',
      scheduledDeletionAt: input.scheduledDeletionAt ?? null,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;

  const [primary] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:primary`, name: 'Ana', timezone: input.primaryTz })
    .returning({ id: schema.users.id });
  const primaryUserId = primary?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: primaryUserId, role: 'primary_parent' });

  if (input.coParentTz !== undefined) {
    const [co] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${familyId}:co`, name: 'Sam', timezone: input.coParentTz })
      .returning({ id: schema.users.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: co?.id as string, role: 'co_parent' });
  }

  for (const child of input.children ?? []) {
    await db.database.insert(schema.children).values({ familyId, ...child });
  }
  return { familyId, primaryUserId };
}

/**
 * The real deps, with only the four things a test cannot have: the phone network, the
 * consent/enrolment state the gate reads from tables this test does not seed, and the
 * registration ladder. Selection, the children read, the dedupe key, the ledger write and
 * the prefs write are all production code.
 */
function prodDeps(
  sent: Array<{ to: string; body: string }>,
  options: { realCap?: boolean } = {},
): EveningCheckInDeps {
  return {
    ...defaultEveningCheckInDeps(),
    buildGate: (database) => ({
      ...buildOutboundGatePorts(database),
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      proactiveSentSince: async () => false,
      ...(options.realCap === true ? {} : { countProactiveSends: async () => 0 }),
    }),
    readinessStanding: async () => null,
    resolveSendablePhone: async () => '+14165550100',
    transport: {
      send: async (input) => {
        sent.push(input);
        return { providerMessageId: `prov-${sent.length}` };
      },
    },
  };
}

describe('who the sweep actually selects, and what it may call their children', () => {
  it("runs on the PRIMARY parent's clock and never names a teenager", async () => {
    // Two live households whose parents are in opposite zones, so a join on the wrong
    // member sends at the wrong hour rather than merely picking the wrong row.
    const toronto = await seedFamily({
      primaryTz: 'America/Toronto',
      coParentTz: 'America/Vancouver',
      children: [
        { name: 'Mia', dateOfBirth: '2022-03-10' },
        { name: 'Noah', dateOfBirth: '2012-02-01' },
      ],
    });
    const vancouver = await seedFamily({
      primaryTz: 'America/Vancouver',
      coParentTz: 'America/Toronto',
    });
    await seedFamily({ primaryTz: 'America/Toronto', stage: 'pending_invite' });
    await seedFamily({ primaryTz: 'America/Toronto', scheduledDeletionAt: new Date() });

    const sent: Array<{ to: string; body: string }> = [];
    const first = await runEveningCheckInSweep(db.database, prodDeps(sent), TORONTO_EVENING);
    expect({ inSlot: first.inSlot, asked: first.asked }).toEqual({ inSlot: 1, asked: 1 });
    expect(sent).toHaveLength(1);
    // The four-year-old is named; the fourteen-year-old is not, and the sentence reads as
    // though she were the only child on file (rule #1).
    expect(sent[0]?.body).toContain('with Mia?');
    expect(sent[0]?.body).not.toContain('Noah');

    const [ask] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, toronto.familyId));
    expect(ask?.parentUserId).toBe(toronto.primaryUserId);
    expect(ask?.category).toBe('evening_check_in');
    expect(ask?.templateKey).toBe(CHECK_IN_ASK_TEMPLATE_KEY);
    expect(ask?.dedupeKey).toBe(`evening_check_in:${toronto.familyId}:2026-07-05`);

    // Three hours later it is the Vancouver household's evening, and only theirs.
    const later = await runEveningCheckInSweep(db.database, prodDeps(sent), VANCOUVER_EVENING);
    expect({ inSlot: later.inSlot, asked: later.asked }).toEqual({ inSlot: 1, asked: 1 });
    const [second] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, vancouver.familyId));
    expect(second?.parentUserId).toBe(vancouver.primaryUserId);
  });

  it('asks again the next evening — the nightly cap is not what holds the nightly question', async () => {
    await seedFamily({ primaryTz: 'America/Toronto' });
    const sent: Array<{ to: string; body: string }> = [];
    const first = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      TORONTO_EVENING,
    );
    expect(first.asked).toBe(1);
    await alignLedgerToSendClock();

    // The same slot, exactly 24h on — the worst case the cap's window has to clear, since
    // two consecutive evenings can be no further apart than this.
    const nextEvening = new Date(TORONTO_EVENING.getTime() + 24 * 3_600_000);
    const second = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      nextEvening,
    );
    expect({ asked: second.asked, capped: second.held.frequency_cap }).toEqual({
      asked: 1,
      capped: 0,
    });
    expect(sent).toHaveLength(2);
  });

  it('puts the least recently asked household at the front of the hour', async () => {
    // Inserted in the OPPOSITE order to the one the sweep must use, so a select that
    // leaned on the table's own order would send these two the other way round.
    const askedLastNight = await seedFamily({ primaryTz: 'America/Toronto' });
    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId: askedLastNight.familyId,
      lastAskedAt: new Date(TORONTO_EVENING.getTime() - 24 * 3_600_000),
    });
    const neverAsked = await seedFamily({ primaryTz: 'America/Toronto' });

    const sent: Array<{ to: string; body: string }> = [];
    const order: string[] = [];
    const deps = prodDeps(sent);
    const { selectFamilies } = deps;
    deps.selectFamilies = async (database) => {
      const rows = await selectFamilies(database);
      order.push(...rows.map((row) => row.familyId));
      return rows;
    };

    await runEveningCheckInSweep(db.database, deps, TORONTO_EVENING);
    expect(order).toEqual([neverAsked.familyId, askedLastNight.familyId]);
  });

  it('is stopped three separate ways from asking twice in one evening', async () => {
    const { familyId } = await seedFamily({ primaryTz: 'America/Toronto' });
    const sent: Array<{ to: string; body: string }> = [];
    await runEveningCheckInSweep(db.database, prodDeps(sent), TORONTO_EVENING);
    expect(sent).toHaveLength(1);
    await alignLedgerToSendClock();

    const tenMinutesOn = new Date(TORONTO_EVENING.getTime() + 10 * 60_000);

    // 1. the prefs row this evening's ask wrote.
    const again = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      tenMinutesOn,
    );
    expect(again.skipped.asked_today).toBe(1);

    // 2. with that row gone — a prefs write that never landed — the real frequency cap.
    await db.database
      .delete(schema.familyCheckInPrefs)
      .where(eq(schema.familyCheckInPrefs.familyId, familyId));
    const capped = await runEveningCheckInSweep(
      db.database,
      prodDeps(sent, { realCap: true }),
      tenMinutesOn,
    );
    expect(capped.held.frequency_cap).toBe(1);

    // 3. and with the cap blinded too, the dedupe key on the ledger row itself.
    const deduped = await runEveningCheckInSweep(db.database, prodDeps(sent), tenMinutesOn);
    expect(deduped.duplicate).toBe(1);

    expect(sent).toHaveLength(1);
  });
});
