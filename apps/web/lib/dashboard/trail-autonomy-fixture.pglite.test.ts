import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { seedSmokeAutonomyTrail } from '~/scripts/fixtures/smoke-autonomy-trail';
import { loadTrailForFamily } from './trail-query';

/**
 * History is the only place a parent sees what Hale did on its own, or that they
 * switched it off (VIL-131). The rows the smoke seed writes for the design
 * screenshots are read back here through the real trail query, so the screenshots
 * and this test describe the same rows.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const ON_ITS_OWN = 'carried out the action on its own';
const PARENT_APPROVED = 'carried out the action';

let db: TestDb;
let fam: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db.database);
  await seedSmokeAutonomyTrail(db.database, fam, NOW);
});

afterAll(async () => {
  await db.close();
});

async function trailRows() {
  const trail = await loadTrailForFamily(db.database, fam.familyId);
  return trail.map((row) => ({ actor: row.actor, summary: row.summary, noun: row.noun }));
}

describe('the smoke family’s History shows what Hale did on its own', () => {
  it('reads newest first: the switch-off, the email Hale sent on its own, the dismissed form, the form brought as a draft', async () => {
    expect(await trailRows()).toEqual([
      { actor: 'you', summary: 'you stopped Hale doing this on its own', noun: 'consent' },
      { actor: 'hale', summary: ON_ITS_OWN, noun: 'draft' },
      { actor: 'you', summary: 'you dismissed a draft', noun: 'draft' },
      { actor: 'hale', summary: 'brought a draft to you', noun: 'draft' },
    ]);
  });

  it('gives each step its own day, so no row is folded into another', async () => {
    const trail = await loadTrailForFamily(db.database, fam.familyId);
    expect(new Set(trail.map((row) => row.dayKey)).size).toBe(4);
  });

  it('leaves nothing waiting on the parent, so the seeded Approvals queue stays empty', async () => {
    const actions = await db.database
      .select({ state: schema.actions.userVisibleState })
      .from(schema.actions);
    expect(actions.map((row) => row.state).sort()).toEqual(['autonomous', 'reverted']);
  });

  it('an action a parent approved reads differently from one Hale did on its own', async () => {
    const [email] = await db.database
      .select({ id: schema.actions.id })
      .from(schema.actions)
      .where(eq(schema.actions.actionType, 'send_email'));
    if (!email) throw new Error('fixture: no send_email action');
    await db.database.insert(schema.auditLog).values({
      familyId: fam.familyId,
      actor: 'system',
      actionTaken: 'action.executed',
      targetTable: 'actions',
      targetId: email.id,
      after: { kind: 'email_sent', decision: { source: 'human', reason: 'a parent approved it' } },
      occurredAt: NOW,
    });

    const [newest] = await trailRows();

    expect(newest).toEqual({ actor: 'hale', summary: PARENT_APPROVED, noun: 'draft' });
    expect(ON_ITS_OWN).not.toBe(PARENT_APPROVED);
  });
});
