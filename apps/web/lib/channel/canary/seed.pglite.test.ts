import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { CANARY_PHONE_E164, canaryChannel } from './config';
import { seedCanaryHousehold } from './seed';

/**
 * The one household this repo writes straight onto the production roster, so
 * what it writes is checked against what the product's own enrolment writes:
 * a verified channel, the CASL consent record behind it, and the audit row
 * (rules #1 and #6). `consent_record_id` is nullable, so the orphan the script
 * used to create would have succeeded silently.
 */

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('seedCanaryHousehold', () => {
  it('enrols the channel WITH its consent record and audit row, and resolves as the canary', async () => {
    const result = await seedCanaryHousehold(db.database);
    expect(result).toEqual({ status: 'created', familyId: expect.any(String) });
    if (result.status !== 'created') throw new Error('unreachable');

    const [channel] = await db.database
      .select({
        id: schema.parentChannels.id,
        consentRecordId: schema.parentChannels.consentRecordId,
        verifiedAt: schema.parentChannels.verifiedAt,
        revokedAt: schema.parentChannels.revokedAt,
      })
      .from(schema.parentChannels)
      .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(CANARY_PHONE_E164)));
    if (!channel) throw new Error('no canary channel was written');
    expect(channel.verifiedAt).toBeInstanceOf(Date);
    expect(channel.revokedAt).toBeNull();

    // The channel POINTS AT a granted consent row — not merely "a consent row
    // exists somewhere".
    const [consent] = await db.database
      .select({
        consentType: schema.consentRecords.consentType,
        granted: schema.consentRecords.granted,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.id, channel.consentRecordId ?? ''));
    expect(consent).toEqual({ consentType: 'sms_service_messages', granted: true });

    const audits = await db.database
      .select({ targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, result.familyId),
          eq(schema.auditLog.actionTaken, 'channel_sms_enrolled'),
        ),
      );
    expect(audits).toEqual([{ targetId: channel.id }]);

    // The point of the whole household: the door resolves this number to it.
    expect(await canaryChannel(db.database)).toMatchObject({ familyId: result.familyId });
  });

  it('is idempotent on the blind index — a re-run adds no second household', async () => {
    const first = await seedCanaryHousehold(db.database);
    const again = await seedCanaryHousehold(db.database);

    expect(again).toEqual({ status: 'already_seeded', familyId: first.familyId });
    const families = await db.database.select({ id: schema.families.id }).from(schema.families);
    expect(families).toHaveLength(1);
  });

  it('reports a revoked channel rather than pretending the canary is armed', async () => {
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: new Date() })
      .where(eq(schema.parentChannels.phoneE164Hash, phoneBlindIndex(CANARY_PHONE_E164)));

    expect((await seedCanaryHousehold(db.database)).status).toBe('inactive');
  });
});
