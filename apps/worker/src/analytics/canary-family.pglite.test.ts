import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import {
  canaryPhoneBlindIndex,
  familyIsCanary,
  resetCanaryFamilyCacheForTests,
} from './canary-family.js';

/**
 * The worker's copy of the probe-number blind index. The expected hash is the
 * same vector apps/web/lib/analytics/canary-tag.pglite.test.ts pins, so the two
 * derivations cannot drift apart. No message text is involved.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const PROBE_HASH = '4e85394a73776d0d59478b18bd5d906735a0cc666d097d5290133c1b17fb357e';

let db: TestDb;
let probeFamilyId: string;
let parentFamilyId: string;

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  db = await createTestDb();
  const probe = await seedFamily(db.database, 'Probe');
  const parent = await seedFamily(db.database, 'Parent');
  probeFamilyId = probe.familyId;
  parentFamilyId = parent.familyId;
  await db.database.insert(schema.parentChannels).values({
    userId: probe.parentUserId,
    familyId: probe.familyId,
    kind: 'sms',
    phoneE164Encrypted: 'not-read',
    phoneE164Hash: canaryPhoneBlindIndex(),
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
  });
});

afterAll(() => {
  resetCanaryFamilyCacheForTests();
});

describe('familyIsCanary', () => {
  it('matches the configured probe number and not a neighbouring family', async () => {
    expect(canaryPhoneBlindIndex()).toBe(PROBE_HASH);
    expect(await familyIsCanary(probeFamilyId, db.database)).toBe(true);
    expect(await familyIsCanary(parentFamilyId, db.database)).toBe(false);
  });
});
