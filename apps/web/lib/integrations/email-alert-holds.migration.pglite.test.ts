import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from '~/lib/testing/pglite';

const MIGRATION = '0228_email_alert_holds.sql';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('0225 email alert holds', () => {
  it('is in the migration chain', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('refuses a debt closed without an outcome, and one email held twice', async () => {
    const family = await seedFamily(db.database);
    const [receipt] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'email_alert',
        templateKey: 'connector:email_alert',
        status: 'suppressed_quiet_hours',
      })
      .returning({ id: schema.channelMessages.id });
    const hold = {
      channelMessageId: receipt?.id as string,
      integrationId: '00000000-0000-4000-8000-0000000000aa',
      messageId: 'm1',
      heldAt: new Date('2026-09-17T11:50:00.000Z'),
    };
    await db.database.insert(schema.emailAlertHolds).values(hold);
    await expect(db.database.insert(schema.emailAlertHolds).values(hold)).rejects.toThrow();
    await expect(
      db.database
        .insert(schema.emailAlertHolds)
        .values({ ...hold, messageId: 'm2', closedAt: new Date() }),
    ).rejects.toThrow();
  });

  it('applies a second time without throwing', async () => {
    await expect(db.applyMigration(MIGRATION)).resolves.toBeUndefined();
  });
});
