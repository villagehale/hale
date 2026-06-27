import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';

// family.ts statically imports the Auth.js session reader for currentFamilyId().
// ensureUserRow (the unit under test here) never touches it, but the static import
// would otherwise drag the next-auth runtime into this Node test. Stub the edge.
vi.mock('~/auth', () => ({ auth: vi.fn() }));

// eq(col, val) → a marker so resolveFamilyForUser's fake can read the external
// auth id it filtered on. ensureUserRow's fake ignores the where, so this is safe.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: (_col: unknown, val: unknown) => ({ __eq: true, val }) };
});

import { ensureUserRow, resolveFamilyForUser } from './family.js';

const GOOGLE_ID = 'google_user_abc';
const CREDENTIALS_ID = 'credentials:cred-1';
const EXISTING_USER_ID = '11111111-1111-4111-8111-111111111111';
const NEW_USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * In-memory fake of the narrow db surface ensureUserRow uses: an idempotent
 * insert(users).onConflictDoNothing() keyed on external_auth_id, then a
 * select(users.id).where(external_auth_id = ?). Mirrors the unique-index
 * dedup the real Postgres schema enforces, so the resolve-or-create branching
 * is exercised without a live connection.
 */
function fakeDb(seed: Array<{ id: string; externalAuthId: string }> = []) {
  const rows = [...seed];

  const insert = vi.fn(() => ({
    values: (value: { externalAuthId: string }) => ({
      onConflictDoNothing: vi.fn(async () => {
        const exists = rows.some((r) => r.externalAuthId === value.externalAuthId);
        if (!exists) {
          rows.push({ id: NEW_USER_ID, externalAuthId: value.externalAuthId });
        }
      }),
    }),
  }));

  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const found = rows.find((r) => r.externalAuthId === GOOGLE_ID);
          return found ? [{ id: found.id }] : [];
        },
      }),
    }),
  }));

  const db = { insert, select } as unknown as Database;
  return { db, insert, select, rows };
}

describe('ensureUserRow', () => {
  it('returns the existing id without inserting when a row already exists', async () => {
    const { db, insert } = fakeDb([{ id: EXISTING_USER_ID, externalAuthId: GOOGLE_ID }]);

    const id = await ensureUserRow(
      { externalAuthId: GOOGLE_ID, email: 'parent@example.com', name: 'Avery' },
      db,
    );

    expect(id).toBe(EXISTING_USER_ID);
    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts and returns the new id when no row exists', async () => {
    const { db, insert } = fakeDb();

    const id = await ensureUserRow(
      { externalAuthId: GOOGLE_ID, email: 'parent@example.com', name: 'Avery' },
      db,
    );

    expect(id).toBe(NEW_USER_ID);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('is idempotent under repeated calls — second call writes nothing and returns the same id', async () => {
    const { db, insert } = fakeDb();

    const first = await ensureUserRow(
      { externalAuthId: GOOGLE_ID, email: 'parent@example.com', name: 'Avery' },
      db,
    );
    const second = await ensureUserRow(
      { externalAuthId: GOOGLE_ID, email: 'parent@example.com', name: 'Avery' },
      db,
    );

    expect(first).toBe(NEW_USER_ID);
    expect(second).toBe(NEW_USER_ID);
    // First call inserts (conflict no-ops), second call resolves the existing row
    // up front and never reaches the insert.
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

/**
 * The whole point of the credentials provider: identity is still just
 * users.external_auth_id, so a credentials user (`credentials:<id>`) resolves to a
 * family through the SAME lookup as a Google user (the OAuth `sub`). This fake maps
 * external_auth_id → family with no knowledge of the id's format; the test proves
 * both id shapes resolve identically.
 */
function familyLookupDb(mapping: Record<string, string>) {
  const select = vi.fn(() => ({
    from: () => ({
      innerJoin: () => ({
        where: (marker: { val: string }) => ({
          limit: async () => {
            const familyId = mapping[marker.val];
            return familyId ? [{ familyId }] : [];
          },
        }),
      }),
    }),
  }));
  return { db: { select } as unknown as Database };
}

describe('resolveFamilyForUser — provider-agnostic identity', () => {
  const FAMILY_ID = '55555555-5555-4555-8555-555555555555';

  it('resolves a credentials user to a family the same way as a Google user', async () => {
    const google = familyLookupDb({ [GOOGLE_ID]: FAMILY_ID });
    const credentials = familyLookupDb({ [CREDENTIALS_ID]: FAMILY_ID });

    expect(await resolveFamilyForUser(GOOGLE_ID, google.db)).toBe(FAMILY_ID);
    expect(await resolveFamilyForUser(CREDENTIALS_ID, credentials.db)).toBe(FAMILY_ID);
  });

  it('returns null for an external auth id with no membership (either provider)', async () => {
    const { db } = familyLookupDb({});

    expect(await resolveFamilyForUser(CREDENTIALS_ID, db)).toBeNull();
  });
});
