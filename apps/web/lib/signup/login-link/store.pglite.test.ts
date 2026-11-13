import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestDb,
  createTestDb,
  migrationFiles,
  seedChild,
  seedFamily,
} from '~/lib/testing/pglite';
import { recordSignupOffer } from '../store';
import { hashLoginCode, loginLinkUrl, newLoginCode } from './code';
import {
  type LoginLinkPurpose,
  consumeLoginLink,
  hasOpenLoginLink,
  loginLinkForNotice,
  lookupLoginLink,
  markLoginLinkSent,
  mintFreshLoginLink,
} from './store';

const NOW = new Date('2026-12-01T12:00:00.000Z');
const URL = 'https://haltonhills.perfectmind.com/Clients/x';
const PURPOSE: LoginLinkPurpose = {
  kind: 'login_ask',
  sessionLabel: 'Preschool Swim Sat 9:00',
  opensAt: { local: 'Tuesday, December 1, 2026 at 7:00 a.m.', timeZone: 'America/Toronto' },
  card: { title: 'Connexion pour haltonhills.perfectmind.com', description: 'Natation sam. 9:00' },
};
const HOST = 'haltonhills.perfectmind.com';
const ONE_LIVE_MIGRATION = migrationFiles().find((file) =>
  file.endsWith('_provider_login_links_one_live.sql'),
);

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

  it('a retried notice reuses the card it already sent, and the parent keeps that one live card', async () => {
    const f = await family();
    const input = {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      providerHost: HOST,
      purpose: PURPOSE,
      now: NOW,
    };
    const first = await loginLinkForNotice(db.database, input);
    if (first.status !== 'minted') throw new Error('expected a minted card');
    expect(await hasOpenLoginLink(db.database, { ...input, now: NOW })).toBe(false);
    await markLoginLinkSent(db.database, { id: first.id, familyId: f.familyId, now: NOW });
    expect(await hasOpenLoginLink(db.database, { ...input, now: NOW })).toBe(true);

    const retry = await loginLinkForNotice(db.database, {
      ...input,
      purpose: { ...PURPOSE, card: null },
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(retry).toEqual({ status: 'reused', id: first.id });
    const firstCode = first.url.split('/').pop() as string;
    expect(await lookupLoginLink(db.database, firstCode, NOW)).toMatchObject({
      ok: true,
      purpose: PURPOSE,
    });
  });

  it('a card that never reached the parent is replaced, and another notice never reuses a card', async () => {
    const f = await family();
    const input = {
      familyId: f.familyId,
      parentUserId: f.parentUserId,
      offerId: f.offerId,
      providerHost: HOST,
      purpose: PURPOSE,
      now: NOW,
    };
    const unsent = await loginLinkForNotice(db.database, input);
    if (unsent.status !== 'minted') throw new Error('expected a minted card');
    const again = await loginLinkForNotice(db.database, input);
    if (again.status !== 'minted') throw new Error('an unsent card must not be reused');
    expect(again.id).not.toBe(unsent.id);
    expect(await lookupLoginLink(db.database, unsent.url.split('/').pop() as string, NOW)).toEqual({
      ok: false,
      reason: 'used',
    });

    await markLoginLinkSent(db.database, { id: again.id, familyId: f.familyId, now: NOW });
    const otherKind = await loginLinkForNotice(db.database, {
      ...input,
      purpose: { ...PURPOSE, kind: 'account_prep' },
    });
    expect(otherKind.status).toBe('minted');
    const fresh = await mintFreshLoginLink(db.database, {
      ...input,
      purpose: { ...PURPOSE, kind: 'password_rejected' },
    });
    expect(fresh.id).not.toBe(again.id);
    const live = await db.database
      .select({ id: schema.providerLoginLinks.id })
      .from(schema.providerLoginLinks)
      .where(
        and(
          eq(schema.providerLoginLinks.familyId, f.familyId),
          isNull(schema.providerLoginLinks.consumedAt),
        ),
      );
    expect(live).toEqual([{ id: fresh.id }]);
  });

  it('holds one live card per host in the schema, and the migration survives a second pass', async () => {
    expect(ONE_LIVE_MIGRATION).toBeDefined();
    await db.applyMigration(ONE_LIVE_MIGRATION as string);
    await db.applyMigration(ONE_LIVE_MIGRATION as string);
    const f = await family();
    const insert = (host: string, consumedAt: Date | null) =>
      db.database.insert(schema.providerLoginLinks).values({
        familyId: f.familyId,
        parentUserId: f.parentUserId,
        offerId: f.offerId,
        providerHost: host,
        tokenHash: hashLoginCode(newLoginCode()),
        expiresAt: NOW,
        consumedAt,
      });
    await insert(HOST, null);
    // Positive controls: a spent card and another host do not hold this host's slot.
    await expect(insert(HOST, NOW)).resolves.toBeDefined();
    await expect(insert('register.example-rec.test', null)).resolves.toBeDefined();
    await expect(insert(HOST, null)).rejects.toThrow(/provider_login_links_one_live_per_host/);
  });
});
