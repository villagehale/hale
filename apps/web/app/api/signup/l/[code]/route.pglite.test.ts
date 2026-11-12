import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_CREDENTIALS_ENABLED_ENV } from '~/lib/signup/credentials/flag';
import { PROVIDER_CREDENTIALS_MASTER_KEY_ENV } from '~/lib/signup/credentials/kms';
import { lookupLoginLink, mintFreshLoginLink } from '~/lib/signup/login-link/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

const harness = vi.hoisted(() => ({ db: undefined as unknown as TestDb }));
vi.mock('~/lib/db', () => ({ db: () => harness.db.database }));

import { POST } from './route';

const HOST = 'haltonhills.perfectmind.com';

beforeAll(async () => {
  harness.db = await createTestDb();
});
afterAll(async () => {
  await harness.db.close();
});
beforeEach(() => {
  vi.stubEnv(PROVIDER_CREDENTIALS_ENABLED_ENV, 'true');
  vi.stubEnv(PROVIDER_CREDENTIALS_MASTER_KEY_ENV, Buffer.alloc(32, 9).toString('base64'));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function save(code: string, body: Record<string, unknown>) {
  return POST(
    new Request(`https://app.example.test/api/signup/l/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ code }) },
  );
}

describe('POST /api/signup/l/<code>', () => {
  it('a bad authenticator key is a fixable 400 that leaves the card live until a good save', async () => {
    const seeded = await seedFamily(harness.db.database);
    const minted = await mintFreshLoginLink(harness.db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      offerId: null,
      providerHost: HOST,
      purpose: {
        kind: 'login_ask',
        sessionLabel: null,
        opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' },
      },
      now: new Date(),
    });
    const code = minted.url.split('/').pop() as string;

    const bad = await save(code, {
      username: 'parent-login',
      password: 'fixture-pass',
      totpSeed: 'not a key!',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'totp' });
    expect(await lookupLoginLink(harness.db.database, code, new Date())).toMatchObject({
      ok: true,
    });

    const good = await save(code, { username: 'parent-login', password: 'fixture-pass' });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ saved: true, host: HOST });
    expect(await lookupLoginLink(harness.db.database, code, new Date())).toEqual({
      ok: false,
      reason: 'used',
    });
  });
});
