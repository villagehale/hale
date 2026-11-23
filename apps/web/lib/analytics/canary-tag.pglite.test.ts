import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { familyIsCanary, resetCanaryFamilyCacheForTests } from './canary-tag';

/**
 * The canary tag is the household that holds the configured probe number.
 * A body is not an input: this file never writes one.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
/** phoneBlindIndex('+14375550100') under the key above. Locks the worker copy too. */
const PROBE_HASH = '4e85394a73776d0d59478b18bd5d906735a0cc666d097d5290133c1b17fb357e';

let db: TestDb;
let probe: SeededFamily;
let parent: SeededFamily;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  db = await createTestDb();
  probe = await seedFamily(db.database, 'Probe');
  parent = await seedFamily(db.database, 'Parent');
  await db.database.insert(schema.parentChannels).values({
    userId: probe.parentUserId,
    familyId: probe.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
    phoneE164Hash: phoneBlindIndex(CANARY_PHONE_E164),
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
  });
  await db.database.insert(schema.parentChannels).values({
    userId: parent.parentUserId,
    familyId: parent.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString('+15555550199'),
    phoneE164Hash: phoneBlindIndex('+15555550199'),
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
  });
});

afterAll(() => {
  resetCanaryFamilyCacheForTests();
});

describe('familyIsCanary', () => {
  it('matches the configured probe number and not a neighbouring family', async () => {
    expect(phoneBlindIndex(CANARY_PHONE_E164)).toBe(PROBE_HASH);
    expect(await familyIsCanary(probe.familyId, db.database)).toBe(true);
    expect(await familyIsCanary(parent.familyId, db.database)).toBe(false);
  });
});
