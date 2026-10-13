import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadTrailForFamily } from './trail-query';

/**
 * The 7-day unsent mark stays in the audit log. History does not show it.
 * The right-to-access file does: it is a row the parent is owed a copy of.
 */

const AGED_OUT = 'left an on-its-own text unsent after 7 days';

let db: TestDb;
let fam: SeededFamily;

beforeAll(async () => {
  db = await createTestDb();
  fam = await seedFamily(db.database);
  await db.database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: 'system',
    actionTaken: 'autonomy_acted_notice_aged_out',
    targetTable: 'actions',
    targetId: '11111111-1111-4111-8111-111111111111',
    after: { parentUserId: fam.parentUserId },
  });
});

afterAll(async () => {
  await db.close();
});

describe('the aged-out audit row', () => {
  it('stays off History and stays in the export', async () => {
    const history = await loadTrailForFamily(db.database, fam.familyId);
    expect(history.map((row) => row.summary)).not.toContain(AGED_OUT);

    const doc = await assembleFamilyExport(db.database, fam.familyId, {
      actorUserId: fam.parentUserId,
    });
    expect(doc.trail.map((row) => row.summary)).toContain(AGED_OUT);
  });
});
