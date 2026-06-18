import { describe, expect, it, vi } from 'vitest';
import {
  type AddMemberArgs,
  type InviteDb,
  type InviteRow,
  type MarkAcceptedArgs,
  type NewInviteRow,
  createInviteStore,
} from './invite-store.js';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const INVITEE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';
const INVITE_ID = '55555555-5555-4555-8555-555555555555';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// In-memory fake of the minimal db surface the store needs. Mirrors the unique
// token + single-redemption invariants the real Postgres schema enforces, so the
// store's branching logic is exercised without a live connection.
function fakeDb(seed: InviteRow[] = []) {
  const invites = new Map<string, InviteRow>();
  for (const row of seed) invites.set(row.token, row);
  const members = new Set<string>();

  const insertInvite = vi.fn(async (row: NewInviteRow): Promise<{ id: string }> => {
    const stored: InviteRow = {
      id: INVITE_ID,
      familyId: row.familyId,
      token: row.token,
      email: row.email ?? null,
      role: row.role,
      createdByUserId: row.createdByUserId,
      expiresAt: row.expiresAt,
      acceptedAt: null,
      acceptedByUserId: null,
    };
    invites.set(row.token, stored);
    return { id: stored.id };
  });

  const findInviteByToken = vi.fn(async (token: string): Promise<InviteRow | null> => {
    return invites.get(token) ?? null;
  });

  const addMember = vi.fn(async (args: AddMemberArgs): Promise<void> => {
    members.add(`${args.familyId}:${args.userId}`);
  });

  const markAccepted = vi.fn(async (args: MarkAcceptedArgs): Promise<void> => {
    for (const row of invites.values()) {
      if (row.id === args.inviteId) {
        row.acceptedAt = args.now;
        row.acceptedByUserId = args.userId;
      }
    }
  });

  const db: InviteDb = { insertInvite, findInviteByToken, addMember, markAccepted };
  return { db, insertInvite, findInviteByToken, addMember, markAccepted, members };
}

function seededInvite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    id: INVITE_ID,
    familyId: FAMILY_ID,
    token: 'seed-token',
    email: null,
    role: 'co_parent',
    createdByUserId: CREATOR_ID,
    expiresAt: new Date('2026-12-31T00:00:00.000Z'),
    acceptedAt: null,
    acceptedByUserId: null,
    ...overrides,
  };
}

describe('createInvite', () => {
  it('mints a base64url token of the expected length and persists the row', async () => {
    const { db, insertInvite } = fakeDb();
    const now = new Date('2026-06-17T00:00:00.000Z');

    const result = await createInviteStore(db).createInvite({
      familyId: FAMILY_ID,
      createdByUserId: CREATOR_ID,
      now,
    });

    // 18 random bytes → base64url has no padding; ceil(18 * 4 / 3) = 24 chars,
    // drawn only from the URL-safe alphabet.
    expect(result.token).toHaveLength(24);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(insertInvite).toHaveBeenCalledTimes(1);
    expect(insertInvite.mock.calls[0]?.[0]).toMatchObject({
      familyId: FAMILY_ID,
      createdByUserId: CREATOR_ID,
      role: 'co_parent',
      token: result.token,
    });
  });

  it('sets expiry exactly 14 days after now', async () => {
    const { db } = fakeDb();
    const now = new Date('2026-06-17T00:00:00.000Z');

    const result = await createInviteStore(db).createInvite({
      familyId: FAMILY_ID,
      createdByUserId: CREATOR_ID,
      now,
    });

    expect(result.expiresAt.getTime()).toBe(now.getTime() + FOURTEEN_DAYS_MS);
  });

  it('generates a different token on each call', async () => {
    const { db } = fakeDb();
    const store = createInviteStore(db);
    const now = new Date('2026-06-17T00:00:00.000Z');

    const a = await store.createInvite({ familyId: FAMILY_ID, createdByUserId: CREATOR_ID, now });
    const b = await store.createInvite({ familyId: FAMILY_ID, createdByUserId: CREATOR_ID, now });

    expect(a.token).not.toBe(b.token);
  });
});

describe('acceptInvite', () => {
  it('adds a family member with the invite role and marks the invite accepted', async () => {
    const { db, addMember, markAccepted, members } = fakeDb([seededInvite()]);
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: INVITEE_ID,
      now,
    });

    expect(result).toEqual({ status: 'accepted', familyId: FAMILY_ID, alreadyMember: false });
    expect(addMember).toHaveBeenCalledWith({
      familyId: FAMILY_ID,
      userId: INVITEE_ID,
      role: 'co_parent',
      invitedByUserId: CREATOR_ID,
    });
    expect(markAccepted).toHaveBeenCalledWith({
      inviteId: INVITE_ID,
      userId: INVITEE_ID,
      now,
    });
    expect(members.has(`${FAMILY_ID}:${INVITEE_ID}`)).toBe(true);
  });

  it('is idempotent when the same user re-accepts (no second member write)', async () => {
    const { db, addMember, markAccepted } = fakeDb([
      seededInvite({
        acceptedAt: new Date('2026-06-18T00:00:00.000Z'),
        acceptedByUserId: INVITEE_ID,
      }),
    ]);
    const now = new Date('2026-06-19T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: INVITEE_ID,
      now,
    });

    expect(result).toEqual({ status: 'accepted', familyId: FAMILY_ID, alreadyMember: true });
    expect(addMember).not.toHaveBeenCalled();
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('rejects an expired token without adding a member', async () => {
    const { db, addMember } = fakeDb([
      seededInvite({ expiresAt: new Date('2026-06-01T00:00:00.000Z') }),
    ]);
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: INVITEE_ID,
      now,
    });

    expect(result).toEqual({ status: 'expired' });
    expect(addMember).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    const { db, addMember } = fakeDb();
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'does-not-exist',
      userId: INVITEE_ID,
      now,
    });

    expect(result).toEqual({ status: 'not_found' });
    expect(addMember).not.toHaveBeenCalled();
  });

  it('rejects a second different user after the invite was already accepted', async () => {
    const { db, addMember } = fakeDb([
      seededInvite({
        acceptedAt: new Date('2026-06-18T00:00:00.000Z'),
        acceptedByUserId: INVITEE_ID,
      }),
    ]);
    const now = new Date('2026-06-19T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: OTHER_USER_ID,
      now,
    });

    expect(result).toEqual({ status: 'already_accepted' });
    expect(addMember).not.toHaveBeenCalled();
  });

  it('accepts a targeted invite when the accepting email matches (case-insensitive)', async () => {
    const { db, addMember, members } = fakeDb([seededInvite({ email: 'Invitee@Example.com' })]);
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: INVITEE_ID,
      email: 'invitee@example.com',
      now,
    });

    expect(result).toEqual({ status: 'accepted', familyId: FAMILY_ID, alreadyMember: false });
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(members.has(`${FAMILY_ID}:${INVITEE_ID}`)).toBe(true);
  });

  it('rejects (wrong_recipient) and writes nothing when a targeted invite email does not match', async () => {
    const { db, addMember, markAccepted } = fakeDb([
      seededInvite({ email: 'targeted@example.com' }),
    ]);
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: OTHER_USER_ID,
      email: 'someone-else@example.com',
      now,
    });

    expect(result).toEqual({ status: 'wrong_recipient' });
    expect(addMember).not.toHaveBeenCalled();
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('accepts an untargeted (null-email) invite from any signed-in user', async () => {
    const { db, addMember } = fakeDb([seededInvite({ email: null })]);
    const now = new Date('2026-06-18T00:00:00.000Z');

    const result = await createInviteStore(db).acceptInvite({
      token: 'seed-token',
      userId: INVITEE_ID,
      email: 'whoever@example.com',
      now,
    });

    expect(result).toEqual({ status: 'accepted', familyId: FAMILY_ID, alreadyMember: false });
    expect(addMember).toHaveBeenCalledTimes(1);
  });
});
