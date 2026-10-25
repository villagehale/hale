import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_PROBE_PREFIX } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { resolveOpsExclusions } from './metrics-scope';

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const PROBE_PHONE = `${SYNTHETIC_PROBE_PREFIX}0142`;
const REAL_PHONE = '+15555550123';

let db: TestDb;
let probeFamilyId: string;
let realFamilyId: string;

async function seedSmsChannel(familyId: string, userId: string, phone: string): Promise<void> {
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date(),
  });
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = TEST_KEY;
  db = await createTestDb();
  const probe = await seedFamily(db.database, 'Probe Household');
  await seedSmsChannel(probe.familyId, probe.parentUserId, PROBE_PHONE);
  const real = await seedFamily(db.database, 'Wren Household');
  await seedSmsChannel(real.familyId, real.parentUserId, REAL_PHONE);
  probeFamilyId = probe.familyId;
  realFamilyId = real.familyId;
}, 120_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.close();
});

describe('resolveOpsExclusions', () => {
  it('excludes the probe-range household and keeps the real one', async () => {
    const excluded = await resolveOpsExclusions(db.database, [probeFamilyId, realFamilyId]);
    expect(excluded.has(probeFamilyId)).toBe(true);
    expect(excluded.has(realFamilyId)).toBe(false);
  });

  it('throws without APP_ENCRYPTION_KEY rather than counting probes as families', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    await expect(resolveOpsExclusions(db.database, [probeFamilyId, realFamilyId])).rejects.toThrow(
      /APP_ENCRYPTION_KEY/,
    );
  });
});
