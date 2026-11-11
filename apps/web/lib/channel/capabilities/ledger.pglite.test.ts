import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { trailVerb } from '~/lib/trail/verbs';
import { loadOwedCorrections, recordCapabilityNotes } from './ledger';

/**
 * VIL-303 · a no is a row once the reply that said it was sent, a lit capability turns
 * it into a correction owed to the parent who heard it, and the correction closes it.
 */

const TOLD = new Date('2026-10-02T15:00:00.000Z');
const LATER = new Date('2026-11-09T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.database.execute(sql`delete from capability_denials`);
  vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', '');
  vi.stubEnv('WATCHED_SPOTS_ENABLED', '');
  vi.stubEnv('F14_ENABLED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function coParent(familyId: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-co@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('no co-parent');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

function lightSpotWatch() {
  vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
  vi.stubEnv('F14_ENABLED', 'true');
}

describe('recordCapabilityNotes', () => {
  it('records one open no per parent and capability, each with its audit row', async () => {
    const family = await seedFamily(db.database);
    const notes = { declined: ['spot_watch' as const], corrected: [] };
    const input = {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      notes,
      channelMessageId: 'msg-told',
      now: TOLD,
    };

    expect(await recordCapabilityNotes(db.database, input)).toEqual({
      status: 'recorded',
      declined: 1,
      corrected: 0,
    });
    // Saying the same no again owes one correction, not two.
    expect(
      await recordCapabilityNotes(db.database, { ...input, channelMessageId: 'msg-2' }),
    ).toEqual({ status: 'recorded', declined: 0, corrected: 0 });

    const rows = await db.database.select().from(schema.capabilityDenials);
    expect(rows).toEqual([
      expect.objectContaining({
        familyId: family.familyId,
        userId: family.parentUserId,
        capability: 'spot_watch',
        deniedIn: 'msg-told',
        correctedAt: null,
      }),
    ]);
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetTable, 'capability_denials'));
    expect(audits).toEqual([
      { action: 'capability_denial_recorded', after: { capability: 'spot_watch' } },
    ]);
  });

  it('writes nothing for a reply that has no ledger row', async () => {
    const family = await seedFamily(db.database);
    const outcome = await recordCapabilityNotes(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      notes: { declined: ['sign_up'], corrected: [] },
      channelMessageId: null,
      now: TOLD,
    });

    expect(outcome).toEqual({ status: 'not_recorded', reason: 'no_ledger_row' });
    expect(await db.database.select().from(schema.capabilityDenials)).toEqual([]);
  });

  it("corrects only the parent who heard it: the co-parent's open no stays open", async () => {
    const family = await seedFamily(db.database);
    const other = await coParent(family.familyId);
    for (const [parentUserId, channelMessageId] of [
      [family.parentUserId, 'msg-told-a'],
      [other, 'msg-told-b'],
    ] as const) {
      await recordCapabilityNotes(db.database, {
        familyId: family.familyId,
        parentUserId,
        notes: { declined: ['spot_watch'], corrected: [] },
        channelMessageId,
        now: TOLD,
      });
    }

    expect(
      await recordCapabilityNotes(db.database, {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        notes: { declined: [], corrected: ['spot_watch'] },
        channelMessageId: 'msg-fixed-a',
        now: LATER,
      }),
    ).toEqual({ status: 'recorded', declined: 0, corrected: 1 });

    const rows = await db.database
      .select({
        userId: schema.capabilityDenials.userId,
        correctedAt: schema.capabilityDenials.correctedAt,
      })
      .from(schema.capabilityDenials);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.userId === family.parentUserId)?.correctedAt).toEqual(LATER);
    expect(rows.find((row) => row.userId === other)?.correctedAt).toBeNull();
  });

  it('keeps both rows off the family History while the audit rows stay', async () => {
    const family = await seedFamily(db.database);
    const scope = { familyId: family.familyId, parentUserId: family.parentUserId };
    await recordCapabilityNotes(db.database, {
      ...scope,
      notes: { declined: ['spot_watch'], corrected: [] },
      channelMessageId: 'msg-told',
      now: TOLD,
    });
    await recordCapabilityNotes(db.database, {
      ...scope,
      notes: { declined: [], corrected: ['spot_watch'] },
      channelMessageId: 'msg-fixed',
      now: LATER,
    });
    // Positive control: a family-wide row on the same trail is shown.
    await db.database.insert(schema.auditLog).values({
      familyId: family.familyId,
      actor: 'system',
      actionTaken: 'commitment_recorded',
      targetTable: 'commitments',
      targetId: family.familyId,
    });

    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, family.familyId),
          eq(schema.auditLog.targetTable, 'capability_denials'),
        ),
      );
    expect(audits.map((a) => a.action).sort()).toEqual([
      'capability_denial_corrected',
      'capability_denial_recorded',
    ]);
    const trail = await loadTrailForFamily(db.database, family.familyId);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.summary).toContain(trailVerb('commitment_recorded').sentence);
  });
});

describe('loadOwedCorrections', () => {
  it('owes the parent who heard the no a correction once the capability is lit', async () => {
    const family = await seedFamily(db.database);
    const other = await coParent(family.familyId);
    await recordCapabilityNotes(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      notes: { declined: ['spot_watch', 'sign_up'], corrected: [] },
      channelMessageId: 'msg-told',
      now: TOLD,
    });
    const scope = { familyId: family.familyId, parentUserId: family.parentUserId };

    // Both still dark: nothing is owed yet.
    expect(await loadOwedCorrections(db.database, scope)).toEqual([]);

    lightSpotWatch();
    expect(await loadOwedCorrections(db.database, scope)).toEqual([
      { capability: 'spot_watch', toldOn: '2026-10-02' },
    ]);
    // The co-parent never heard the no.
    expect(
      await loadOwedCorrections(db.database, { familyId: family.familyId, parentUserId: other }),
    ).toEqual([]);
  });

  it('closes on the correction, and a later no opens a new one', async () => {
    lightSpotWatch();
    const family = await seedFamily(db.database);
    const scope = { familyId: family.familyId, parentUserId: family.parentUserId };
    await recordCapabilityNotes(db.database, {
      ...scope,
      notes: { declined: ['spot_watch'], corrected: [] },
      channelMessageId: 'msg-told',
      now: TOLD,
    });

    expect(
      await recordCapabilityNotes(db.database, {
        ...scope,
        notes: { declined: [], corrected: ['spot_watch'] },
        channelMessageId: 'msg-fixed',
        now: LATER,
      }),
    ).toEqual({ status: 'recorded', declined: 0, corrected: 1 });
    expect(await loadOwedCorrections(db.database, scope)).toEqual([]);
    const [row] = await db.database.select().from(schema.capabilityDenials);
    expect(row).toEqual(expect.objectContaining({ correctedAt: LATER, correctedBy: 'msg-fixed' }));
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, row?.id ?? ''));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'capability_denial_corrected',
      'capability_denial_recorded',
    ]);

    await recordCapabilityNotes(db.database, {
      ...scope,
      notes: { declined: ['spot_watch'], corrected: [] },
      channelMessageId: 'msg-again',
      now: LATER,
    });
    expect(await db.database.select().from(schema.capabilityDenials)).toHaveLength(2);
  });
});
