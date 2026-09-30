import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '../testing/pglite.js';
import { recordSpendCeilingExceeded } from './memory-writer.js';

/**
 * The warn is once per family per UTC day. The dedupe is a read of audit_log,
 * which a chain fake cannot lose — the second write the same day has to see the
 * first row.
 */

let db: TestDb;
let familyId: string;

beforeAll(async () => {
  db = await createTestDb();
  const seeded = await seedFamily(db.database);
  familyId = seeded.familyId;
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('recordSpendCeilingExceeded', () => {
  it('writes one warn per family per UTC day and another the next day', async () => {
    const detail = { ceilingUsd: 6, enforced: false };
    const first = await recordSpendCeilingExceeded(
      { familyId, day: '2026-09-30', detail },
      db.database,
    );
    const second = await recordSpendCeilingExceeded(
      { familyId, day: '2026-09-30', detail },
      db.database,
    );
    const next = await recordSpendCeilingExceeded(
      { familyId, day: '2026-10-01', detail },
      db.database,
    );

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(next.recorded).toBe(true);

    const rows = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    const warns = rows.filter((row) => row.actionTaken === 'spend_ceiling_exceeded_warn');
    expect(warns).toHaveLength(2);
  });
});
