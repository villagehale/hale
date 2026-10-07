import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { runDeletionSweep } from '~/lib/rights/delete';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { ROSTER_RETENTION_DAYS, sweepRosterRetention } from './roster-retention';

/**
 * A roster member is a number Hale read from a group, not a person who asked Hale for
 * anything. Once that number has said no, left, or never belonged to a family, keeping it
 * encrypted forever is retention with no purpose (rule #1, PIPEDA). The blind index stays
 * so the same phone is still recognised on a re-add.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-06T18:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST_RETENTION = new Date(NOW.getTime() - (ROSTER_RETENTION_DAYS + 1) * DAY_MS);
const WITHIN_RETENTION = new Date(NOW.getTime() - (ROSTER_RETENTION_DAYS - 1) * DAY_MS);

let db: TestDb;
let phones = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  db = await createTestDb();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table linq_group_rosters, families, users cascade');
});

function nextPhone(): string {
  phones += 1;
  return `+1416555${String(1000 + phones).slice(-4)}`;
}

async function seedFamily(options: { scheduledDeletionAt?: Date } = {}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Household',
      provinceOrState: 'ON',
      scheduledDeletionAt: options.scheduledDeletionAt,
    })
    .returning({ id: schema.families.id });
  return family?.id as string;
}

async function seedRoster(input: {
  chatId: string;
  familyId: string | null;
  status: schema.LinqGroupRosterStatus;
  updatedAt: Date;
}) {
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({
      chatId: input.chatId,
      familyId: input.familyId,
      source: 'added_to_existing',
      status: input.status,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })
    .returning({ id: schema.linqGroupRosters.id });
  return roster?.id as string;
}

async function seedMember(input: {
  rosterId: string;
  chatId: string;
  status: schema.LinqRosterMemberStatus;
  updatedAt: Date;
}) {
  const phone = nextPhone();
  const [member] = await db.database
    .insert(schema.linqGroupRosterMembers)
    .values({
      rosterId: input.rosterId,
      chatId: input.chatId,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      status: input.status,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })
    .returning({ id: schema.linqGroupRosterMembers.id });
  return { id: member?.id as string, hash: phoneBlindIndex(phone) };
}

async function member(id: string) {
  const [row] = await db.database
    .select({
      encrypted: schema.linqGroupRosterMembers.phoneE164Encrypted,
      hash: schema.linqGroupRosterMembers.phoneE164Hash,
      status: schema.linqGroupRosterMembers.status,
    })
    .from(schema.linqGroupRosterMembers)
    .where(eq(schema.linqGroupRosterMembers.id, id));
  return row ?? null;
}

async function rosterChats() {
  const rows = await db.database
    .select({ chatId: schema.linqGroupRosters.chatId })
    .from(schema.linqGroupRosters);
  return rows.map((row) => row.chatId).sort();
}

async function retentionAudit() {
  return db.database
    .select({
      familyId: schema.auditLog.familyId,
      actor: schema.auditLog.actor,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, 'linq_group_roster_numbers_released'));
}

describe('sweepRosterRetention — flag off', () => {
  it("releases nothing and names flag_off, which is today's delete sweep", async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    const rosterId = await seedRoster({
      chatId: 'chat-flag-off',
      familyId: null,
      status: 'no_family',
      updatedAt: PAST_RETENTION,
    });
    const memberId = await seedMember({
      rosterId,
      chatId: 'chat-flag-off',
      status: 'declined',
      updatedAt: PAST_RETENTION,
    });

    expect(await sweepRosterRetention(db.database, NOW)).toEqual({ outcome: 'flag_off' });
    expect(await rosterChats()).toEqual(['chat-flag-off']);
    expect((await member(memberId.id))?.encrypted).not.toBeNull();
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  });
});

describe('sweepRosterRetention — rosters that belong to no family', () => {
  it.each(['no_family', 'mixed_family', 'not_group', 'refused'] as const)(
    'deletes a family-less %s roster past retention with its members, and keeps a younger one',
    async (status) => {
      const oldRoster = await seedRoster({
        chatId: 'chat-old-stranger',
        familyId: null,
        status,
        updatedAt: PAST_RETENTION,
      });
      await seedMember({
        rosterId: oldRoster,
        chatId: 'chat-old-stranger',
        status: 'proposed',
        updatedAt: PAST_RETENTION,
      });
      await seedMember({
        rosterId: oldRoster,
        chatId: 'chat-old-stranger',
        status: 'known_parent',
        updatedAt: PAST_RETENTION,
      });
      const youngRoster = await seedRoster({
        chatId: 'chat-young-stranger',
        familyId: null,
        status,
        updatedAt: WITHIN_RETENTION,
      });
      const youngMember = await seedMember({
        rosterId: youngRoster,
        chatId: 'chat-young-stranger',
        status: 'proposed',
        updatedAt: WITHIN_RETENTION,
      });

      const summary = await sweepRosterRetention(db.database, NOW);

      expect(summary).toEqual({
        outcome: 'swept',
        familylessRostersDeleted: 1,
        familylessMembersDeleted: 2,
        numbersReleased: 0,
        numbersReleasedWithoutFamily: 0,
        familiesAudited: 0,
      });
      expect(await rosterChats()).toEqual(['chat-young-stranger']);
      expect((await member(youngMember.id))?.encrypted).not.toBeNull();
      const leftover = await db.database
        .select({ chatId: schema.linqGroupRosterMembers.chatId })
        .from(schema.linqGroupRosterMembers);
      expect(leftover).toEqual([{ chatId: 'chat-young-stranger' }]);
    },
  );

  it('keeps an old roster a family holds, and an old family-less roster still pending', async () => {
    const familyId = await seedFamily();
    await seedRoster({
      chatId: 'chat-family-refused',
      familyId,
      status: 'refused',
      updatedAt: PAST_RETENTION,
    });
    await seedRoster({
      chatId: 'chat-pending',
      familyId: null,
      status: 'roster_pending',
      updatedAt: PAST_RETENTION,
    });

    const summary = await sweepRosterRetention(db.database, NOW);

    expect(summary).toMatchObject({ outcome: 'swept', familylessRostersDeleted: 0 });
    expect(await rosterChats()).toEqual(['chat-family-refused', 'chat-pending']);
  });
});

describe('sweepRosterRetention — numbers of members who were never seated', () => {
  it.each(['declined', 'not_family', 'left', 'removed', 'refused'] as const)(
    'nulls the encrypted number of a %s member past retention and keeps its blind index',
    async (status) => {
      const familyId = await seedFamily();
      const rosterId = await seedRoster({
        chatId: 'chat-family',
        familyId,
        status: 'partial',
        updatedAt: WITHIN_RETENTION,
      });
      const gone = await seedMember({
        rosterId,
        chatId: 'chat-family',
        status,
        updatedAt: PAST_RETENTION,
      });
      const goneRecently = await seedMember({
        rosterId,
        chatId: 'chat-family',
        status,
        updatedAt: WITHIN_RETENTION,
      });

      const summary = await sweepRosterRetention(db.database, NOW);

      expect(summary).toEqual({
        outcome: 'swept',
        familylessRostersDeleted: 0,
        familylessMembersDeleted: 0,
        numbersReleased: 1,
        numbersReleasedWithoutFamily: 0,
        familiesAudited: 1,
      });
      expect(await member(gone.id)).toEqual({ encrypted: null, hash: gone.hash, status });
      expect((await member(goneRecently.id))?.encrypted).not.toBeNull();

      expect(await retentionAudit()).toEqual([
        {
          familyId,
          actor: 'system',
          after: { numbersReleased: 1, retentionDays: ROSTER_RETENTION_DAYS },
        },
      ]);
    },
  );

  it('leaves seated and still-asked members untouched however old', async () => {
    const familyId = await seedFamily();
    const rosterId = await seedRoster({
      chatId: 'chat-family',
      familyId,
      status: 'partial',
      updatedAt: PAST_RETENTION,
    });
    const kept = await Promise.all(
      (['known_parent', 'confirmed', 'asked', 'reasked', 'proposed'] as const).map((status) =>
        seedMember({ rosterId, chatId: 'chat-family', status, updatedAt: PAST_RETENTION }),
      ),
    );

    const summary = await sweepRosterRetention(db.database, NOW);

    expect(summary).toMatchObject({ outcome: 'swept', numbersReleased: 0, familiesAudited: 0 });
    for (const row of kept) {
      expect((await member(row.id))?.encrypted).not.toBeNull();
    }
    expect(await retentionAudit()).toEqual([]);
  });

  it('is idempotent: a second run releases nothing and writes no second audit row', async () => {
    const familyId = await seedFamily();
    const rosterId = await seedRoster({
      chatId: 'chat-family',
      familyId,
      status: 'confirmed',
      updatedAt: PAST_RETENTION,
    });
    await seedMember({
      rosterId,
      chatId: 'chat-family',
      status: 'declined',
      updatedAt: PAST_RETENTION,
    });
    await seedMember({
      rosterId,
      chatId: 'chat-family',
      status: 'left',
      updatedAt: PAST_RETENTION,
    });
    await seedRoster({
      chatId: 'chat-stranger',
      familyId: null,
      status: 'no_family',
      updatedAt: PAST_RETENTION,
    });

    const first = await sweepRosterRetention(db.database, NOW);
    const second = await sweepRosterRetention(db.database, NOW);

    expect(first).toMatchObject({
      numbersReleased: 2,
      familylessRostersDeleted: 1,
      familiesAudited: 1,
    });
    expect(second).toEqual({
      outcome: 'swept',
      familylessRostersDeleted: 0,
      familylessMembersDeleted: 0,
      numbersReleased: 0,
      numbersReleasedWithoutFamily: 0,
      familiesAudited: 0,
    });
    expect(await retentionAudit()).toEqual([
      {
        familyId,
        actor: 'system',
        after: { numbersReleased: 2, retentionDays: ROSTER_RETENTION_DAYS },
      },
    ]);
  });
});

describe('family erasure takes the family’s rosters with it', () => {
  it('runDeletionSweep removes the erased family’s roster and every member number', async () => {
    const erased = await seedFamily({ scheduledDeletionAt: new Date(NOW.getTime() - DAY_MS) });
    const staying = await seedFamily();
    const erasedRoster = await seedRoster({
      chatId: 'chat-erased',
      familyId: erased,
      status: 'confirmed',
      updatedAt: NOW,
    });
    await seedMember({
      rosterId: erasedRoster,
      chatId: 'chat-erased',
      status: 'confirmed',
      updatedAt: NOW,
    });
    await seedMember({
      rosterId: erasedRoster,
      chatId: 'chat-erased',
      status: 'declined',
      updatedAt: NOW,
    });
    const stayingRoster = await seedRoster({
      chatId: 'chat-staying',
      familyId: staying,
      status: 'confirmed',
      updatedAt: NOW,
    });
    await seedMember({
      rosterId: stayingRoster,
      chatId: 'chat-staying',
      status: 'confirmed',
      updatedAt: NOW,
    });

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    expect(await rosterChats()).toEqual(['chat-staying']);
    const members = await db.database
      .select({ chatId: schema.linqGroupRosterMembers.chatId })
      .from(schema.linqGroupRosterMembers);
    expect(members).toEqual([{ chatId: 'chat-staying' }]);
  });
});
