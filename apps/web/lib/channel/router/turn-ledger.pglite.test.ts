import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { auditTurnLedger, TURN_ANSWERED_ACTION } from './wiring';

/**
 * The ANSWERED row is a CLAIM, not a note (audit P1-4 seam 1). The drain is
 * at-least-once and the 180s-expiry era made concurrent consumers of one turn real:
 * both read stageOf() as 'fresh' before either answered, so the ledger's only honest
 * defence is that the WRITE arbitrates — the unique index in migration 0106 lets
 * exactly one recordAnswered win, and the loser is told, by the database, that its
 * send was a duplicate. A fake cannot prove that (the injected-fakes lesson), so this
 * runs the real DDL.
 *
 * Mutation proof: revert wiring.ts recordAnswered to the plain unconditional insert
 * (read-then-act) and 'refuses the second ANSWERED claim' fails — both calls return
 * 'claimed' and two answered rows land.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('auditTurnLedger answered claim', () => {
  it('refuses the second ANSWERED claim for one turn and keeps a single row', async () => {
    const fam = await seedFamily(db.database, 'Claim Family');
    const ledger = auditTurnLedger(db.database);
    const channelMessageId = randomUUID();
    const turn = {
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channelMessageId,
    };

    // Both consumers passed the stageOf gate before either answered — the exact
    // interleaving the read alone cannot stop.
    expect(await ledger.stageOf(turn)).toBe('fresh');
    expect(await ledger.recordAnswered(turn)).toBe('claimed');
    expect(await ledger.recordAnswered(turn)).toBe('already_answered');

    // Positive control on the negative claim: exactly ONE answered row exists, and
    // the re-drive gate reads it.
    const rows = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, TURN_ANSWERED_ACTION),
          eq(schema.auditLog.targetId, channelMessageId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(await ledger.stageOf(turn)).toBe('answered');
  });

  it('claims independent turns independently (the claim cannot fail open OR closed)', async () => {
    const fam = await seedFamily(db.database, 'Second Family');
    const ledger = auditTurnLedger(db.database);
    const first = {
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channelMessageId: randomUUID(),
    };
    const second = { ...first, channelMessageId: randomUUID() };

    expect(await ledger.recordAnswered(first)).toBe('claimed');
    expect(await ledger.recordAnswered(second)).toBe('claimed');
  });

  it('leaves the deferred arc unclaimed: nine re-drives may each record a defer', async () => {
    const fam = await seedFamily(db.database, 'Deferred Family');
    const ledger = auditTurnLedger(db.database);
    const turn = {
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channelMessageId: randomUUID(),
    };

    await ledger.recordDeferred(turn);
    await ledger.recordDeferred(turn);
    expect(await ledger.stageOf(turn)).toBe('deferred');

    // The turn that finally answers still claims cleanly over its defer history.
    expect(await ledger.recordAnswered(turn)).toBe('claimed');
    expect(await ledger.stageOf(turn)).toBe('answered');
  });
});
