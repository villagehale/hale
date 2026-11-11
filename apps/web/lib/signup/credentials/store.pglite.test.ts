import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { recordSignupOffer } from '../store';
import { PROVIDER_CREDENTIALS_ENABLED_ENV } from './flag';
import { PROVIDER_CREDENTIALS_MASTER_KEY_ENV } from './kms';
import {
  CREDENTIAL_RETENTION_MS,
  deleteProviderCredentials,
  loadCredentialsForRun,
  markCredentialsStale,
  saveProviderCredentials,
  sweepStaleProviderCredentials,
} from './store';
import { totpCode } from './totp';

const NOW = new Date('2026-12-01T12:00:00.000Z');
const HOST = 'register.example-rec.test';
const MASTER = Buffer.alloc(32, 9).toString('base64');
const TOTP_SEED = 'JBSWY3DPEHPK3PXP';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
  vi.stubEnv(PROVIDER_CREDENTIALS_MASTER_KEY_ENV, MASTER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function family() {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  return { ...seeded, childId };
}

describe('encrypted provider credentials', () => {
  it('is off unless the flag is exactly true', async () => {
    vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, '');
    const f = await family();
    expect(
      await saveProviderCredentials(db.database, {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        providerHost: HOST,
        username: 'ada',
        password: 'secret',
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'flag_off' });
  });

  it('encrypts, decrypts only for a run, and never stores plaintext', async () => {
    const f = await family();
    expect(
      await saveProviderCredentials(db.database, {
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        providerHost: HOST,
        username: 'ada',
        password: 'city-pass',
        totpSeed: TOTP_SEED,
        now: NOW,
      }),
    ).toEqual({ ok: true });
    const [row] = await db.database
      .select()
      .from(schema.providerSignupCredentials)
      .where(
        and(
          eq(schema.providerSignupCredentials.familyId, f.familyId),
          eq(schema.providerSignupCredentials.providerHost, HOST),
        ),
      );
    expect(row?.usernameCiphertext).not.toContain('ada');
    expect(JSON.stringify(row)).not.toContain('city-pass');
    expect(JSON.stringify(row)).not.toContain(TOTP_SEED);

    const loaded = await loadCredentialsForRun(db.database, {
      familyId: f.familyId,
      providerHost: HOST,
      now: NOW,
    });
    expect(loaded).toEqual({
      username: 'ada',
      password: 'city-pass',
      totp: totpCode(TOTP_SEED, NOW),
    });
    expect(loaded?.totp).toMatch(/^\d{6}$/);
  });

  it('skips a stale row until a new save clears it', async () => {
    const f = await family();
    await saveProviderCredentials(db.database, {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      providerHost: HOST,
      username: 'ada',
      password: 'old',
      now: NOW,
    });
    expect(
      await markCredentialsStale(db.database, {
        familyId: f.familyId,
        providerHost: HOST,
        now: NOW,
      }),
    ).toBe(true);
    expect(
      await loadCredentialsForRun(db.database, {
        familyId: f.familyId,
        providerHost: HOST,
        now: NOW,
      }),
    ).toBeNull();
    await saveProviderCredentials(db.database, {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      providerHost: HOST,
      username: 'ada',
      password: 'new',
      now: NOW,
    });
    expect(
      await loadCredentialsForRun(db.database, {
        familyId: f.familyId,
        providerHost: HOST,
        now: NOW,
      }),
    ).toMatchObject({ password: 'new' });
  });

  it('deletes on request and sweeps credentials older than 45 days with no live plan', async () => {
    const live = await family();
    const aged = await family();
    await saveProviderCredentials(db.database, {
      familyId: live.familyId,
      parentUserId: live.parentUserId,
      providerHost: HOST,
      username: 'live',
      password: 'x',
      now: NOW,
    });
    await saveProviderCredentials(db.database, {
      familyId: aged.familyId,
      parentUserId: aged.parentUserId,
      providerHost: HOST,
      username: 'aged',
      password: 'y',
      now: NOW,
    });
    const offer = await recordSignupOffer(db.database, {
      familyId: live.familyId,
      childId: live.childId,
      parentUserId: live.parentUserId,
      activityKey: 'swim',
      registrationUrl: `https://${HOST}/x`,
      sessions: [
        {
          id: 'sat',
          label: 'Sat',
          startsAt: '2027-01-09T14:00:00.000Z',
          endsAt: '2027-01-09T14:45:00.000Z',
          full: false,
          priceCents: 9800,
        },
      ],
      approvedPriceCents: null,
      now: NOW,
    });
    if (!offer.ok) throw new Error(offer.reason);
    const cutoff = new Date(NOW.getTime() - CREDENTIAL_RETENTION_MS - 1000);
    await db.database
      .update(schema.providerSignupCredentials)
      .set({ updatedAt: cutoff })
      .where(eq(schema.providerSignupCredentials.familyId, aged.familyId));
    expect(await sweepStaleProviderCredentials(db.database, NOW)).toEqual({ deleted: 1 });
    expect(
      await loadCredentialsForRun(db.database, {
        familyId: aged.familyId,
        providerHost: HOST,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      await loadCredentialsForRun(db.database, {
        familyId: live.familyId,
        providerHost: HOST,
        now: NOW,
      }),
    ).toMatchObject({ username: 'live' });
    expect(await deleteProviderCredentials(db.database, { familyId: live.familyId })).toBe(1);
  });
});
