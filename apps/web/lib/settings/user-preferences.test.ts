import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';

// readUserPreferences is keyed by the caller's EXTERNAL auth id (the Auth.js
// session id / Google sub), NOT the internal users.id uuid — a text sub can never
// equal a uuid, so a query straight at users.id always misses and always returns
// the metric/Monday defaults. This drives the REAL two-step lookup the lib does:
// resolveUserIdForUser(external → users.id) THEN read prefs at users.id. The bug
// this guards is the read silently defaulting for any non-default preference.

// family.ts statically imports the Auth.js session reader for currentFamilyId();
// the resolver under test never touches it. Stub the edge so the next-auth runtime
// stays out of this Node test.
vi.mock('~/auth', () => ({ auth: vi.fn() }));

// eq(col, val) → a marker carrying the filtered value, so the fake db can tell the
// external-auth-id resolution query apart from the users.id prefs read.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: (_col: unknown, val: unknown) => ({ __eq: true, val }) };
});

import { readUserPreferences } from './user-preferences.js';

const EXTERNAL_AUTH_ID = 'google-sub-abc';
const INTERNAL_USER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * In-memory fake of the two sequential select().from(users).where().limit()
 * calls readUserPreferences makes: first resolveUserIdForUser filters on
 * external_auth_id (returns the internal id), then the prefs read filters on
 * users.id (returns the stored row). Keyed on the eq() marker's value so the two
 * queries are served distinctly — no live connection. `prefsRow: null` models a
 * user with no mirrored row (the read falls back to defaults).
 */
function fakeDb(
  user: { externalAuthId: string; id: string } | null,
  prefsRow: { units: string; weekStartDay: number } | null,
): Database {
  const select = vi.fn(() => ({
    from: () => ({
      where: (marker: { val: string }) => ({
        limit: async () => {
          if (user && marker.val === user.externalAuthId) return [{ id: user.id }];
          if (user && marker.val === user.id) return prefsRow ? [prefsRow] : [];
          return [];
        },
      }),
    }),
  }));
  return { select } as unknown as Database;
}

describe('readUserPreferences', () => {
  it('resolves the external auth id to the internal user and returns the STORED prefs (not defaults)', async () => {
    const db = fakeDb(
      { externalAuthId: EXTERNAL_AUTH_ID, id: INTERNAL_USER_ID },
      { units: 'imperial', weekStartDay: 0 },
    );

    const prefs = await readUserPreferences(EXTERNAL_AUTH_ID, db);

    expect(prefs).toEqual({ units: 'imperial', weekStartDay: 0 });
  });

  it('returns the metric/Monday defaults when the external auth id has no mirrored users row', async () => {
    const db = fakeDb(null, null);

    const prefs = await readUserPreferences(EXTERNAL_AUTH_ID, db);

    expect(prefs).toEqual({ units: 'metric', weekStartDay: 1 });
  });
});
