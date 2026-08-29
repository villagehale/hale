import { schema } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import {
  JOIN_LINK_TTL_MS,
  loadOpenJoinInvite,
  loadOpenJoinInviteForFamily,
  mintJoinInvite,
  revokeOpenJoinInvites,
} from './invites';

/**
 * The web-rail additions to the join-invite store (Instinct-adapted /family card):
 * the family-keyed status read, the explicit revoke, and the UI-consent mint (no
 * verbatim sentence — the click is the authorisation). Driven against the intake
 * FakeDb, the same double route.test.ts trusts, so a revoke that "worked" here is a
 * revoke the redemption reader actually refuses.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-28T12:00:00.000Z');

async function mint(db: ReturnType<typeof makeFakeDb>['db'], verbatim: string | null = null) {
  return mintJoinInvite(db, {
    familyId: FAMILY,
    invitedByUserId: PARENT,
    verbatimRequest: verbatim,
    channelMessageId: null,
    now: NOW,
  });
}

describe('loadOpenJoinInviteForFamily', () => {
  it('returns the open invite with its expiry (positive control for every null below)', async () => {
    const fake = makeFakeDb();
    await mint(fake.db);
    const open = await loadOpenJoinInviteForFamily(fake.db, FAMILY, NOW);
    expect(open).not.toBeNull();
    expect(open?.expiresAt.getTime()).toBe(NOW.getTime() + JOIN_LINK_TTL_MS);
  });

  it('never resolves another family’s invite', async () => {
    const fake = makeFakeDb();
    await mint(fake.db);
    expect(await loadOpenJoinInviteForFamily(fake.db, OTHER_FAMILY, NOW)).toBeNull();
  });

  it('applies expiry and the single-use burn ON READ, like the code-keyed loader', async () => {
    const fake = makeFakeDb();
    await mint(fake.db);
    const afterTtl = new Date(NOW.getTime() + JOIN_LINK_TTL_MS + 1);
    expect(await loadOpenJoinInviteForFamily(fake.db, FAMILY, afterTtl)).toBeNull();

    const row = fake.rows(schema.joinInvites)[0];
    expect(row).toBeDefined();
    if (row) row.consumedAt = NOW; // redeemed elsewhere
    expect(await loadOpenJoinInviteForFamily(fake.db, FAMILY, NOW)).toBeNull();
  });
});

describe('revokeOpenJoinInvites', () => {
  it('kills the read everywhere at once — the forwarded code stops buying anything', async () => {
    const fake = makeFakeDb();
    const { code } = await mint(fake.db);
    // Positive control: the code IS live before the revoke.
    expect(await loadOpenJoinInvite(fake.db, code, NOW)).not.toBeNull();

    const { revokedIds } = await revokeOpenJoinInvites(fake.db, {
      familyId: FAMILY,
      actorUserId: PARENT,
      now: NOW,
    });
    expect(revokedIds).toHaveLength(1);
    expect(await loadOpenJoinInvite(fake.db, code, NOW)).toBeNull();
    expect(await loadOpenJoinInviteForFamily(fake.db, FAMILY, NOW)).toBeNull();
  });

  it('writes the audit row for each killed link (rule #6), and none when nothing was open', async () => {
    const fake = makeFakeDb();
    await mint(fake.db);
    await revokeOpenJoinInvites(fake.db, { familyId: FAMILY, actorUserId: PARENT, now: NOW });

    const audits = fake
      .rows(schema.auditLog)
      .filter((row) => row.actionTaken === 'co_parent_join_link_revoked');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(PARENT);

    const again = await revokeOpenJoinInvites(fake.db, {
      familyId: FAMILY,
      actorUserId: PARENT,
      now: NOW,
    });
    expect(again.revokedIds).toEqual([]);
    expect(
      fake.rows(schema.auditLog).filter((row) => row.actionTaken === 'co_parent_join_link_revoked'),
    ).toHaveLength(1);
  });

  it('leaves a link redeemed in the meantime alone — the seat it bought stands', async () => {
    const fake = makeFakeDb();
    await mint(fake.db);
    const row = fake.rows(schema.joinInvites)[0];
    if (row) row.consumedAt = NOW; // the partner got in first
    const { revokedIds } = await revokeOpenJoinInvites(fake.db, {
      familyId: FAMILY,
      actorUserId: PARENT,
      now: NOW,
    });
    expect(revokedIds).toEqual([]);
  });
});

describe('mintJoinInvite from the app (no verbatim sentence)', () => {
  it('records the consent with NULL evidence — the documented UI-consent convention', async () => {
    const fake = makeFakeDb();
    await mint(fake.db, null);
    const consent = fake
      .rows(schema.consentRecords)
      .find((row) => row.consentType === 'co_parent_access_grant');
    expect(consent).toBeDefined();
    expect(consent?.granted).toBe(true);
    expect(consent?.evidence).toBeNull();
  });

  it('still carries the parent’s own words when the request came from the thread', async () => {
    const fake = makeFakeDb();
    await mint(fake.db, 'add my partner');
    const consent = fake
      .rows(schema.consentRecords)
      .find((row) => row.consentType === 'co_parent_access_grant');
    expect((consent?.evidence as { verbatimReply?: string })?.verbatimReply).toBe('add my partner');
  });
});
