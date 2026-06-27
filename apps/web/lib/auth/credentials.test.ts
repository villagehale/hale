import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateCredential,
  credentialExternalAuthId,
  registerCredential,
  validateSignup,
  verifyEmailToken,
} from './credentials';
import { MAX_PASSWORD_LENGTH } from './constants';
import { verifyPassword } from './password';

/**
 * Security-focused tests for the email+password core. The hashing is REAL
 * (@node-rs/argon2, no mock) so "stored hash is not the plaintext" and "the right
 * password verifies" are proven end-to-end, not stubbed.
 *
 * The DB is a tiny in-memory fake with REAL unique-email semantics
 * (onConflictDoNothing returns no row on a duplicate), so "duplicate email
 * handled" is a genuine assertion about the source-of-truth index. Drizzle's `eq`
 * is mocked to a {col,val} marker the fake turns into a predicate — the only seam
 * needed to run the module's real queries against an in-memory store.
 */

// eq(col, val) → a marker the fake's where() interprets. The rest of drizzle-orm
// is untouched.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, eq: (col: unknown, val: unknown) => ({ __eq: true, col, val }) };
});

interface Row {
  id: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  verificationToken: string | null;
  verificationSentAt: Date | null;
}

type EqMarker = { __eq: true; col: unknown; val: unknown };

const COLUMN_KEY = new Map<unknown, keyof Row>([
  [schema.credentials.id, 'id'],
  [schema.credentials.email, 'email'],
  [schema.credentials.verificationToken, 'verificationToken'],
]);

function predicateFrom(marker: EqMarker): (r: Row) => boolean {
  const key = COLUMN_KEY.get(marker.col);
  if (!key) throw new Error('fake db: unexpected where column');
  return (r) => r[key] === marker.val;
}

function thenable(result: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable
    then: (resolve: (v: unknown[]) => unknown) => resolve(result),
  };
}

/** Asserts a row exists and returns it — keeps the security assertions free of
 * optional chaining while satisfying strict-null checks. */
function first(rows: Row[]): Row {
  const r = rows[0];
  if (!r) throw new Error('expected a credentials row');
  return r;
}

function projection(r: Row, cols: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(cols)) {
    out[key] = (r as unknown as Record<string, unknown>)[key];
  }
  return out;
}

/** In-memory `credentials` table with real unique-email + update semantics,
 * exposed as the Drizzle-shaped builder this module uses. `selectCalls` counts
 * row lookups so a test can prove an early-return path never touched the DB. */
function fakeDb(initial: Row[] = []): { db: Database; rows: Row[]; selectCalls: () => number } {
  const rows = [...initial];
  let counter = initial.length;
  let selects = 0;

  const db = {
    insert() {
      return {
        values(v: {
          email: string;
          passwordHash: string;
          verificationToken?: string | null;
          verificationSentAt?: Date | null;
        }) {
          return {
            onConflictDoNothing() {
              const conflict = rows.some((r) => r.email === v.email);
              return {
                returning() {
                  if (conflict) return thenable([]);
                  counter += 1;
                  const row: Row = {
                    id: `cred-${counter}`,
                    email: v.email,
                    passwordHash: v.passwordHash,
                    emailVerifiedAt: null,
                    verificationToken: v.verificationToken ?? null,
                    verificationSentAt: v.verificationSentAt ?? null,
                  };
                  rows.push(row);
                  return thenable([{ id: row.id }]);
                },
              };
            },
          };
        },
      };
    },
    select(cols: Record<string, unknown>) {
      selects += 1;
      return {
        from() {
          return {
            where(marker: EqMarker) {
              const predicate = predicateFrom(marker);
              return {
                limit(n: number) {
                  return thenable(rows.filter(predicate).slice(0, n).map((r) => projection(r, cols)));
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(patch: Partial<Row>) {
          return {
            where(marker: EqMarker) {
              const predicate = predicateFrom(marker);
              for (const r of rows) if (predicate(r)) Object.assign(r, patch);
              return thenable([]);
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as Database, rows, selectCalls: () => selects };
}

const EMAIL = 'parent@example.com';
const PASSWORD = 'correct horse battery';
const VERIFIED = { requireVerified: true } as const;
const UNVERIFIED_OK = { requireVerified: false } as const;

describe('validateSignup', () => {
  it('rejects a malformed email', () => {
    expect(validateSignup('not-an-email', PASSWORD)).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('rejects a password shorter than the minimum', () => {
    expect(validateSignup('a@b.co', 'short')).toEqual({ ok: false, error: 'weak_password' });
  });

  it('normalizes a valid email to lowercase + trimmed', () => {
    expect(validateSignup('  USER@Example.COM ', PASSWORD)).toEqual({
      ok: true,
      email: 'user@example.com',
    });
  });
});

describe('credentialExternalAuthId', () => {
  it('namespaces the credential id so it can never collide with a Google sub', () => {
    expect(credentialExternalAuthId('abc')).toBe('credentials:abc');
  });
});

describe('registerCredential', () => {
  it('stores an argon2id hash, never the plaintext, and the hash verifies', async () => {
    const { db, rows } = fakeDb();

    const result = await registerCredential(EMAIL, PASSWORD, db);

    expect(result.ok).toBe(true);
    expect(rows).toHaveLength(1);
    const stored = first(rows);
    expect(stored.passwordHash).not.toBe(PASSWORD);
    expect(stored.passwordHash).not.toContain(PASSWORD);
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    // The stored hash is a real, verifiable hash of the password.
    expect(await verifyPassword(stored.passwordHash, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored.passwordHash, 'wrong password')).toBe(false);
  });

  it('lowercases the email and issues an unverified account with a token', async () => {
    const { db, rows } = fakeDb();

    const result = await registerCredential('  Parent@Example.COM ', PASSWORD, db);

    expect(result.ok).toBe(true);
    expect(first(rows).email).toBe(EMAIL);
    expect(first(rows).emailVerifiedAt).toBeNull();
    if (result.ok) {
      expect(result.verificationToken.length).toBeGreaterThan(20);
      // The result carries the NORMALIZED email so the caller mails the exact
      // address that was stored (no re-normalization divergence).
      expect(result.email).toBe(EMAIL);
    }
  });

  it('rejects a weak password before any row is written', async () => {
    const { db, rows } = fakeDb();

    const result = await registerCredential(EMAIL, 'short', db);

    expect(result).toEqual({ ok: false, error: 'weak_password' });
    expect(rows).toHaveLength(0);
  });

  it('returns email_taken for a duplicate (decided by the unique index, not a pre-check)', async () => {
    const { db, rows } = fakeDb();
    await registerCredential(EMAIL, PASSWORD, db);

    const second = await registerCredential(EMAIL, 'a different password', db);

    expect(second).toEqual({ ok: false, error: 'email_taken' });
    // No second row, and the original password hash is untouched.
    expect(rows).toHaveLength(1);
    expect(await verifyPassword(first(rows).passwordHash, PASSWORD)).toBe(true);
  });
});

describe('authenticateCredential', () => {
  async function seedVerified() {
    const fake = fakeDb();
    await registerCredential(EMAIL, PASSWORD, fake.db);
    first(fake.rows).emailVerifiedAt = new Date();
    return fake;
  }

  it('resolves to the namespaced external auth id on the right password', async () => {
    const { db, rows } = await seedVerified();

    const identity = await authenticateCredential(EMAIL, PASSWORD, db, VERIFIED);

    expect(identity).toEqual({ id: credentialExternalAuthId(first(rows).id), email: EMAIL });
  });

  it('matches regardless of email casing', async () => {
    const { db } = await seedVerified();

    const identity = await authenticateCredential('PARENT@EXAMPLE.COM', PASSWORD, db, VERIFIED);

    expect(identity).not.toBeNull();
  });

  it('returns null (generic failure) on a wrong password', async () => {
    const { db } = await seedVerified();

    expect(await authenticateCredential(EMAIL, 'wrong password', db, VERIFIED)).toBeNull();
  });

  it('returns null for an unknown email (same failure as a wrong password)', async () => {
    const { db } = await seedVerified();

    expect(await authenticateCredential('nobody@example.com', PASSWORD, db, VERIFIED)).toBeNull();
  });

  it('blocks an unverified account when verification is required', async () => {
    const { db } = fakeDb();
    await registerCredential(EMAIL, PASSWORD, db); // emailVerifiedAt stays null

    expect(await authenticateCredential(EMAIL, PASSWORD, db, VERIFIED)).toBeNull();
  });

  it('allows an unverified account when verification is not enforced', async () => {
    const { db } = fakeDb();
    await registerCredential(EMAIL, PASSWORD, db);

    const identity = await authenticateCredential(EMAIL, PASSWORD, db, UNVERIFIED_OK);

    expect(identity).not.toBeNull();
  });

  // H1 (argon2 DoS): the length bound lives in authenticateCredential — the
  // chokepoint a direct POST to /api/auth/callback/credentials also crosses — so an
  // over-length password is rejected BEFORE the DB read and the 19 MiB argon2
  // verify. Proven by asserting no row lookup happened (the verify only runs after
  // the lookup), and that the call is fast (no argon2).
  it('rejects an over-length password without reading the DB or running argon2', async () => {
    const { db, selectCalls } = await seedVerified();
    const before = selectCalls();
    const huge = 'a'.repeat(MAX_PASSWORD_LENGTH + 1);

    const start = performance.now();
    const result = await authenticateCredential(EMAIL, huge, db, VERIFIED);
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    // No row lookup → the password verify (which only runs after the lookup) was
    // never reached, so no argon2 CPU was spent on the attacker's input.
    expect(selectCalls()).toBe(before);
    // A real argon2 verify is ~10ms+; the early return is sub-millisecond.
    expect(elapsed).toBeLessThan(5);
  });

  it('accepts a password at exactly the max length', async () => {
    const maxPw = 'a'.repeat(MAX_PASSWORD_LENGTH);
    const { db, rows } = fakeDb();
    await registerCredential(EMAIL, maxPw, db);
    first(rows).emailVerifiedAt = new Date();

    expect(await authenticateCredential(EMAIL, maxPw, db, VERIFIED)).not.toBeNull();
  });
});

describe('verifyEmailToken', () => {
  it('marks the email verified and burns the token (single use)', async () => {
    const { db, rows } = fakeDb();
    const reg = await registerCredential(EMAIL, PASSWORD, db);
    if (!reg.ok) throw new Error('setup failed');

    const redeemed = await verifyEmailToken(reg.verificationToken, db);
    expect(redeemed).toEqual({ email: EMAIL });
    expect(first(rows).emailVerifiedAt).not.toBeNull();
    expect(first(rows).verificationToken).toBeNull();

    // Replaying the same link now finds nothing — single use.
    expect(await verifyEmailToken(reg.verificationToken, db)).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const { db } = fakeDb();
    await registerCredential(EMAIL, PASSWORD, db);

    expect(await verifyEmailToken('not-a-real-token', db)).toBeNull();
  });

  it('rejects an implausibly long token without a DB lookup (L1 harden)', async () => {
    const { db, selectCalls } = fakeDb();
    await registerCredential(EMAIL, PASSWORD, db);
    const before = selectCalls();

    expect(await verifyEmailToken('x'.repeat(65), db)).toBeNull();
    expect(selectCalls()).toBe(before);
  });

  it('rejects an expired token (older than the TTL)', async () => {
    const { db, rows } = fakeDb();
    const reg = await registerCredential(EMAIL, PASSWORD, db);
    if (!reg.ok) throw new Error('setup failed');
    // Backdate the send well past the 24h window.
    first(rows).verificationSentAt = new Date(Date.now() - 25 * 60 * 60 * 1000);

    expect(await verifyEmailToken(reg.verificationToken, db)).toBeNull();
    expect(first(rows).emailVerifiedAt).toBeNull();
  });
});
