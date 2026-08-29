import { schema } from '@hale/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { loadOpenJoinInviteForFamily } from '~/lib/channel/join/invites';
import { mintCoParentJoinLink, revokeCoParentJoinLinks } from './join-actions';

/**
 * The web door onto the SMS join rail. The auth edges are stubbed (the pattern
 * children-actions.test.ts set) so what runs is the REAL action composition against
 * the intake FakeDb — the one-live-link invariant and the revoke are exercised
 * through the same store the redemption reader trusts.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '33333333-3333-4333-8333-333333333333';

let fakeDbHandle: unknown = {};
const familyIdMock = vi.fn();
const userIdMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => fakeDbHandle }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => familyIdMock(),
  currentUserId: () => userIdMock(),
}));

describe('mintCoParentJoinLink', () => {
  beforeEach(() => {
    familyIdMock.mockResolvedValue(FAMILY);
    userIdMock.mockResolvedValue(PARENT);
  });

  it('mints a link on the SMS rail: /text funnel URL, 7-day expiry, consent + audit rows', async () => {
    const fake = makeFakeDb();
    fakeDbHandle = fake.db;

    const result = await mintCoParentJoinLink();
    expect(result.status).toBe('minted');
    if (result.status !== 'minted') return;
    expect(result.link).toMatch(/\/text\?s=join-[0-9a-f]{32}$/);

    const consent = fake
      .rows(schema.consentRecords)
      .find((row) => row.consentType === 'co_parent_access_grant');
    expect(consent?.granted).toBe(true);
    expect(consent?.evidence).toBeNull(); // UI consent — the click is the evidence
    expect(
      fake.rows(schema.auditLog).some((row) => row.actionTaken === 'co_parent_join_link_minted'),
    ).toBe(true);
  });

  it('keeps ONE live link: a second mint revokes the first before minting', async () => {
    const fake = makeFakeDb();
    fakeDbHandle = fake.db;

    await mintCoParentJoinLink();
    const second = await mintCoParentJoinLink();
    expect(second.status).toBe('minted');

    const open = fake
      .rows(schema.joinInvites)
      .filter(
        (row) => row.consumedAt === null && new Date(row.expiresAt as Date).getTime() > Date.now(),
      );
    expect(fake.rows(schema.joinInvites)).toHaveLength(2); // both rows kept (audit history)
    expect(open).toHaveLength(1); // …but only one still buys a seat
    expect(
      fake.rows(schema.auditLog).some((row) => row.actionTaken === 'co_parent_join_link_revoked'),
    ).toBe(true);
  });

  it('refuses without a resolved family — never a link scoped to nobody', async () => {
    const fake = makeFakeDb();
    fakeDbHandle = fake.db;
    familyIdMock.mockResolvedValue(null);

    expect(await mintCoParentJoinLink()).toEqual({ status: 'unavailable' });
    expect(fake.rows(schema.joinInvites)).toHaveLength(0);
  });
});

describe('revokeCoParentJoinLinks', () => {
  beforeEach(() => {
    familyIdMock.mockResolvedValue(FAMILY);
    userIdMock.mockResolvedValue(PARENT);
  });

  it('kills the outstanding link so the family status read goes quiet', async () => {
    const fake = makeFakeDb();
    fakeDbHandle = fake.db;

    await mintCoParentJoinLink();
    // Positive control before the negative claim below.
    expect(await loadOpenJoinInviteForFamily(fake.db, FAMILY, new Date())).not.toBeNull();

    expect(await revokeCoParentJoinLinks()).toEqual({ status: 'revoked' });
    expect(await loadOpenJoinInviteForFamily(fake.db, FAMILY, new Date())).toBeNull();
  });

  it('answers "none" honestly when there was nothing to revoke', async () => {
    fakeDbHandle = makeFakeDb().db;
    expect(await revokeCoParentJoinLinks()).toEqual({ status: 'none' });
  });
});
