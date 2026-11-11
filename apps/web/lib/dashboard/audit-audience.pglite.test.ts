import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_LOG_AUDIENCE_ENABLED_ENV } from '~/lib/privacy/audit-audience';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadTrailForFamily } from './trail-query';

/**
 * VIL-635 · a one-adult audit row stays with its adult once the flag is on.
 */

const ALERT = 'Hale texted you about something in your email';
const NOW = new Date('2026-11-11T12:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function twoParents() {
  const a = await seedFamily(db.database);
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `${a.familyId}-co@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  const b = co?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: a.familyId, userId: b, role: 'co_parent' });
  await db.database.insert(schema.auditLog).values({
    familyId: a.familyId,
    actor: 'system',
    actionTaken: 'email_alert_sent',
    audience: a.parentUserId,
    targetTable: 'channel_messages',
    targetId: a.parentUserId,
    after: { kind: 'cancellation', teenContent: false, othersCount: null },
  });
  return { familyId: a.familyId, a: a.parentUserId, b };
}

function summaries(trail: { summary: string }[]) {
  return trail.map((row) => row.summary);
}

describe('audit_log.audience (VIL-635)', () => {
  it("B's History and export lack A's email_alert_sent; A's have it", async () => {
    vi.stubEnv(AUDIT_LOG_AUDIENCE_ENABLED_ENV, 'true');
    const { familyId, a, b } = await twoParents();

    expect(
      summaries(await loadTrailForFamily(db.database, familyId, undefined, { viewerUserId: a })),
    ).toContain(ALERT);
    expect(
      summaries(await loadTrailForFamily(db.database, familyId, undefined, { viewerUserId: b })),
    ).not.toContain(ALERT);

    const copyA = await assembleFamilyExport(db.database, familyId, { actorUserId: a, now: NOW });
    const copyB = await assembleFamilyExport(db.database, familyId, { actorUserId: b, now: NOW });
    expect(summaries(copyA.trail)).toContain(ALERT);
    expect(summaries(copyB.trail)).not.toContain(ALERT);
  });

  it("unlit, B still sees A's email_alert_sent (flag-off control)", async () => {
    const { familyId, b } = await twoParents();
    expect(
      summaries(await loadTrailForFamily(db.database, familyId, undefined, { viewerUserId: b })),
    ).toContain(ALERT);
    const copyB = await assembleFamilyExport(db.database, familyId, { actorUserId: b, now: NOW });
    expect(summaries(copyB.trail)).toContain(ALERT);
  });
});
