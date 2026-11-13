import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthLineFacts } from '~/lib/channel/health-line';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { productionChannelCoachPorts } from './runtime';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/**
 * VIL-589. The runtime tests fake this port, and a fake cannot fail on a production
 * wiring that places every family the same way. This drives the REAL port over real rows.
 */
describe('productionChannelCoachPorts · loadHealthPlace', () => {
  it('places each family off its own row: 811 for Ontario, never for the US', async () => {
    const place = async (row: { country: string; postalCode: string }) => {
      const { familyId } = await seedFamily(db.database);
      await db.database.update(schema.families).set(row).where(eq(schema.families.id, familyId));
      return productionChannelCoachPorts(db.database).loadHealthPlace(familyId);
    };
    const ontario = await place({ country: 'CA', postalCode: 'M5V 2T6' });
    const us = await place({ country: 'US', postalCode: '43215' });

    expect(healthLineFacts(ontario).mustInclude).toEqual(['811', '911']);
    expect(healthLineFacts(us).mustInclude).toEqual(['911']);
  });
});
