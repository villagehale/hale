import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { CLAIM_UNCONFIRMED_AGE_MS, sweepUnconfirmedClaims } from './claim-sweep';

/**
 * The executor's claim-before-send residue, made observable (audit P1-6).
 *
 * `outbound_sends` is the claim: a row is inserted BEFORE the provider send, and
 * `sent_at` is stamped only after the provider confirms. A crash between the two
 * leaves a claim nothing will ever confirm — and the redelivery that follows reads
 * the existing claim as "already sent" and marks the action done. Until this sweep,
 * that row had zero readers: an approved email that never went out was structurally
 * indistinguishable from one that did (rule #11).
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');
/** Old enough that no in-flight send can still confirm it. */
const STALE = new Date(NOW.getTime() - CLAIM_UNCONFIRMED_AGE_MS - 60_000);
/** Young enough that the send may simply not have confirmed yet. */
const FRESH = new Date(NOW.getTime() - 60_000);

describe('sweepUnconfirmedClaims', () => {
  let db: TestDb;
  let family: { familyId: string; parentUserId: string };

  // Booted in a hook, not the test body: pglite boot + migrations routinely
  // exceed the 5s test timeout under full parallel CI load, and hooks carry
  // their own timeout budget.
  beforeEach(async () => {
    db = await createTestDb();
    family = await seedFamily(db.database);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedClaim(over: { claimedAt: Date; sentAt?: Date | null }): Promise<{
    claimId: string;
    actionId: string;
  }> {
    const [event] = await db.database
      .insert(schema.events)
      .values({
        familyId: family.familyId,
        source: 'test',
        eventType: 'email.test',
        dedupHash: `dedup-${Math.random()}`,
      })
      .returning({ id: schema.events.id });
    if (!event) throw new Error('seedClaim: events insert returned no row');

    const [action] = await db.database
      .insert(schema.actions)
      .values({
        eventId: event.id,
        familyId: family.familyId,
        actionType: 'send_email',
        payload: {},
      })
      .returning({ id: schema.actions.id });
    if (!action) throw new Error('seedClaim: actions insert returned no row');

    const [claim] = await db.database
      .insert(schema.outboundSends)
      .values({ actionId: action.id, claimedAt: over.claimedAt, sentAt: over.sentAt ?? null })
      .returning({ id: schema.outboundSends.id });
    if (!claim) throw new Error('seedClaim: outbound_sends insert returned no row');

    return { claimId: claim.id, actionId: action.id };
  }

  function sweep() {
    return sweepUnconfirmedClaims({
      database: db.database,
      log: { warn: () => {}, error: () => {} },
      now: () => NOW,
    });
  }

  it('names a stale unconfirmed claim: swept_at stamped, audit row written', async () => {
    const { claimId, actionId } = await seedClaim({ claimedAt: STALE });

    const summary = await sweep();
    expect(summary).toMatchObject({ scanned: 1, swept: 1, alreadyResolved: 0, rowErrors: 0 });

    const [row] = await db.database
      .select({ sweptAt: schema.outboundSends.sweptAt })
      .from(schema.outboundSends)
      .where(eq(schema.outboundSends.id, claimId));
    expect(row?.sweptAt).toEqual(NOW);

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'outbound_send_unconfirmed'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      familyId: family.familyId,
      actor: 'system',
      targetTable: 'outbound_sends',
      targetId: claimId,
    });
    expect(audits[0]?.after).toMatchObject({ actionId });
  });

  it('never touches a confirmed claim, however old', async () => {
    await seedClaim({ claimedAt: STALE, sentAt: new Date(NOW.getTime() - 3_600_000) });

    const summary = await sweep();
    expect(summary).toMatchObject({ scanned: 0, swept: 0 });
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('leaves a fresh claim alone — the send may still be confirming', async () => {
    await seedClaim({ claimedAt: FRESH });

    const summary = await sweep();
    expect(summary).toMatchObject({ scanned: 0, swept: 0 });
  });

  it('reports each stale claim exactly once: the stamp is the claim on reporting it', async () => {
    await seedClaim({ claimedAt: STALE });

    expect((await sweep()).swept).toBe(1);
    const second = await sweep();
    expect(second).toMatchObject({ scanned: 0, swept: 0 });

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'outbound_send_unconfirmed'));
    expect(audits).toHaveLength(1);
  });

  it('two overlapping sweeps still report one stale claim exactly once', async () => {
    await seedClaim({ claimedAt: STALE });

    // Whatever the interleaving — second sweep selects nothing, or selects the row
    // and loses the guarded stamp — one claim is one report, never two.
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.swept + b.swept).toBe(1);

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'outbound_send_unconfirmed'));
    expect(audits).toHaveLength(1);
  });
});
