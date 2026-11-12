import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { recordSignupOffer } from '../store';
import { hashLoginCode, loginLinkUrl, newLoginCode } from './code';
import {
  type LoginLinkPurpose,
  consumeLoginLink,
  lookupLoginLink,
  mintFreshLoginLink,
} from './store';

const NOW = new Date('2026-12-01T12:00:00.000Z');
const URL = 'https://haltonhills.perfectmind.com/Clients/x';
const PURPOSE: LoginLinkPurpose = {
  kind: 'login_ask',
  sessionLabel: 'Preschool Swim Sat 9:00',
  opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' },
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function family() {
  const seeded = await seedFamily(db.database);
  const childId = await seedChild(db.database, seeded.familyId, 'Ada', 40, undefined, NOW);
  const offer = await recordSignupOffer(db.database, {
    familyId: seeded.familyId,
    childId,
    parentUserId: seeded.parentUserId,
    activityKey: 'swim-preschool',
    registrationUrl: URL,
    sessions: [
      {
        id: 'sat-0900',
        label: 'Preschool Swim Sat 9:00',
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
  return { ...seeded, childId, offerId: offer.id };
}

describe('provider login links', () => {
  it('mints a hashed single-use 30-minute code bound to parent and host', async () => {
    const f = await family();
    const minted = await mintFreshLoginLink(db.database, {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      providerHost: 'haltonhills.perfectmind.com',
      purpose: PURPOSE,
      now: NOW,
    });
    expect(minted.url).toMatch(/^https:\/\/app\.villagehale\.com\/l\/[0-9A-Za-z]{10}$/);
    expect(minted.expiresAt.toISOString()).toBe('2026-12-01T12:30:00.000Z');
    const code = minted.url.split('/').pop() as string;
    const [row] = await db.database
      .select()
      .from(schema.providerLoginLinks)
      .where(eq(schema.providerLoginLinks.id, minted.id));
    expect(row?.tokenHash).toBe(hashLoginCode(code));
    expect(row?.tokenHash).not.toBe(code);
    expect(row?.parentUserId).toBe(f.parentUserId);
    expect(row?.providerHost).toBe('haltonhills.perfectmind.com');
    expect(row?.consumedAt).toBeNull();

    const live = await lookupLoginLink(db.database, code, NOW);
    expect(live).toMatchObject({
      ok: true,
      providerHost: 'haltonhills.perfectmind.com',
      purpose: PURPOSE,
    });

    const expired = await lookupLoginLink(db.database, code, new Date(NOW.getTime() + 31 * 60_000));
    expect(expired).toEqual({ ok: false, reason: 'expired' });

    expect(await consumeLoginLink(db.database, { id: minted.id, now: NOW })).toBe(true);
    expect(await lookupLoginLink(db.database, code, NOW)).toEqual({ ok: false, reason: 'used' });
    expect(await consumeLoginLink(db.database, { id: minted.id, now: NOW })).toBe(false);
  });

  it('does not look up an unknown or malformed code', async () => {
    expect(await lookupLoginLink(db.database, newLoginCode(), NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(await lookupLoginLink(db.database, '../etc', NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(loginLinkUrl('AbCdef1234')).not.toContain('login.');
  });

  it('a fresh code replaces every open one for that host', async () => {
    const f = await family();
    const first = await mintFreshLoginLink(db.database, {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      providerHost: 'haltonhills.perfectmind.com',
      purpose: PURPOSE,
      now: NOW,
    });
    const firstCode = first.url.split('/').pop() as string;
    const fresh = await mintFreshLoginLink(db.database, {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      providerHost: 'haltonhills.perfectmind.com',
      purpose: { ...PURPOSE, kind: 'password_rejected' },
      now: NOW,
    });
    expect(fresh.url).not.toBe(first.url);
    expect(await lookupLoginLink(db.database, firstCode, NOW)).toEqual({
      ok: false,
      reason: 'used',
    });
    const freshCode = fresh.url.split('/').pop() as string;
    expect(await lookupLoginLink(db.database, freshCode, NOW)).toMatchObject({ ok: true });
  });
});
