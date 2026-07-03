import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  consumePasswordReset,
  credentialUnverified,
  requestPasswordReset,
  resendVerification,
} from './reset';
import { registerCredential } from './credentials';
import { MIN_PASSWORD_LENGTH } from './constants';
import { verifyPassword } from './password';

/**
 * Security tests for the reset/resend lifecycle. Hashing is REAL (@node-rs/argon2,
 * no mock) so "the new password actually replaces the old hash" is proven
 * end-to-end. The DB is a two-table in-memory fake (credentials +
 * password_reset_tokens) with real single-use / expiry semantics, so the
 * single-use and anti-enumeration claims are genuine assertions, not stubs.
 *
 * drizzle-orm's eq/and/isNull are mocked to plain markers the fake interprets —
 * the only seam needed to run the module's real queries against the store.
 */
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: 'eq', col, val }),
    isNull: (col: unknown) => ({ __op: 'isNull', col }),
    and: (...clauses: unknown[]) => ({ __op: 'and', clauses }),
  };
});

interface CredRow {
  id: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  verificationToken: string | null;
  verificationSentAt: Date | null;
}

interface ResetRow {
  id: string;
  credentialId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

type Marker =
  | { __op: 'eq'; col: unknown; val: unknown }
  | { __op: 'isNull'; col: unknown }
  | { __op: 'and'; clauses: Marker[] };

// Column identity → the (table, key) it addresses. Both tables share the fake, so
// the column object itself disambiguates which store a predicate runs against.
const CRED_COLS = new Map<unknown, keyof CredRow>([
  [schema.credentials.id, 'id'],
  [schema.credentials.email, 'email'],
  [schema.credentials.verificationToken, 'verificationToken'],
]);
const RESET_COLS = new Map<unknown, keyof ResetRow>([
  [schema.passwordResetTokens.id, 'id'],
  [schema.passwordResetTokens.credentialId, 'credentialId'],
  [schema.passwordResetTokens.tokenHash, 'tokenHash'],
  [schema.passwordResetTokens.usedAt, 'usedAt'],
]);

function predicate<T extends object>(cols: Map<unknown, keyof T>, marker: Marker): (r: T) => boolean {
  if (marker.__op === 'and') {
    const parts = marker.clauses.map((c) => predicate(cols, c));
    return (r) => parts.every((p) => p(r));
  }
  const key = cols.get(marker.col);
  if (!key) throw new Error('fake db: unexpected predicate column');
  if (marker.__op === 'isNull') {
    return (r) => r[key] == null;
  }
  return (r) => r[key] === marker.val;
}

function thenable(result: unknown[]) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable
    then: (resolve: (v: unknown[]) => unknown) => resolve(result),
  };
}

function project<T>(r: T, cols: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(cols)) out[key] = (r as Record<string, unknown>)[key];
  return out;
}

/** Asserts the fake holds a row and returns it — keeps the assertions free of
 * non-null operators while satisfying strict-null checks. */
function only<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error('expected a row in the fake');
  return r;
}

/**
 * A fake spanning BOTH tables. The current table is picked per-statement from the
 * schema object passed to insert()/update(), and from the projected columns on
 * select() (they belong to exactly one table).
 */
function fakeDb(): { db: Database; creds: CredRow[]; tokens: ResetRow[] } {
  const creds: CredRow[] = [];
  const tokens: ResetRow[] = [];
  let credCounter = 0;
  let tokenCounter = 0;

  function isResetProjection(cols: Record<string, unknown>): boolean {
    return Object.values(cols).some((c) => RESET_COLS.has(c));
  }

  const db = {
    insert(table: unknown) {
      const isReset = table === schema.passwordResetTokens;
      return {
        values(v: Record<string, unknown>) {
          if (isReset) {
            tokenCounter += 1;
            tokens.push({
              id: `reset-${tokenCounter}`,
              credentialId: v.credentialId as string,
              tokenHash: v.tokenHash as string,
              expiresAt: v.expiresAt as Date,
              usedAt: null,
              createdAt: new Date(),
            });
            return thenable([]);
          }
          // credentials insert (used only by registerCredential setup)
          return {
            onConflictDoNothing() {
              const conflict = creds.some((r) => r.email === v.email);
              return {
                returning() {
                  if (conflict) return thenable([]);
                  credCounter += 1;
                  const row: CredRow = {
                    id: `cred-${credCounter}`,
                    email: v.email as string,
                    passwordHash: v.passwordHash as string,
                    emailVerifiedAt: null,
                    verificationToken: (v.verificationToken as string) ?? null,
                    verificationSentAt: (v.verificationSentAt as Date) ?? null,
                  };
                  creds.push(row);
                  return thenable([{ id: row.id }]);
                },
              };
            },
          };
        },
      };
    },
    select(cols: Record<string, unknown>) {
      const reset = isResetProjection(cols);
      return {
        from() {
          return {
            where(marker: Marker) {
              return {
                limit(n: number) {
                  const rowsOut = reset
                    ? tokens.filter(predicate(RESET_COLS, marker)).slice(0, n).map((r) => project(r, cols))
                    : creds.filter(predicate(CRED_COLS, marker)).slice(0, n).map((r) => project(r, cols));
                  return thenable(rowsOut);
                },
              };
            },
          };
        },
      };
    },
    update(table: unknown) {
      const isReset = table === schema.passwordResetTokens;
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(marker: Marker) {
              if (isReset) {
                for (const r of tokens) if (predicate(RESET_COLS, marker)(r)) Object.assign(r, patch);
              } else {
                for (const r of creds) if (predicate(CRED_COLS, marker)(r)) Object.assign(r, patch);
              }
              return thenable([]);
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as Database, creds, tokens };
}

const EMAIL = 'parent@example.com';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';

async function seedVerified(fake: ReturnType<typeof fakeDb>) {
  await registerCredential(EMAIL, PASSWORD, fake.db);
  const row = fake.creds[0];
  if (!row) throw new Error('setup failed');
  row.emailVerifiedAt = new Date();
  return row;
}

describe('requestPasswordReset — anti-enumeration', () => {
  it('returns the SAME shape for a registered and an unregistered email', async () => {
    const fake = fakeDb();
    await seedVerified(fake);

    const existing = await requestPasswordReset(EMAIL, fake.db);
    const missing = await requestPasswordReset('nobody@example.com', fake.db);

    // Both are `{ email, token }`; the ONLY difference is whether a token was
    // minted (the caller mails a link iff token !== null but always shows one
    // message). The public contract — object keys — is identical.
    expect(Object.keys(existing).sort()).toEqual(Object.keys(missing).sort());
    expect(existing.token).not.toBeNull();
    expect(missing.token).toBeNull();
    // No token row is ever created for a non-existent account.
    expect(fake.tokens).toHaveLength(1);
  });

  it('stores only the token HASH, never the raw token (rule #1)', async () => {
    const fake = fakeDb();
    await seedVerified(fake);

    const result = await requestPasswordReset(EMAIL, fake.db);
    const raw = result.token;
    expect(raw).not.toBeNull();
    const stored = fake.tokens[0];
    if (!raw || !stored) throw new Error('expected a token');
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.tokenHash).not.toContain(raw);
    // 64 hex chars = SHA-256.
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('invalidates a prior unused token when a new one is requested', async () => {
    const fake = fakeDb();
    await seedVerified(fake);

    await requestPasswordReset(EMAIL, fake.db);
    await requestPasswordReset(EMAIL, fake.db);

    const unused = fake.tokens.filter((t) => t.usedAt == null);
    // Exactly one live token — the newest; the earlier one was burned.
    expect(unused).toHaveLength(1);
    expect(unused[0]).toBe(fake.tokens[1]);
  });
});

describe('consumePasswordReset — single-use + expiring', () => {
  it('sets a new argon2 hash, verifies with the new password, and burns the token', async () => {
    const fake = fakeDb();
    const cred = await seedVerified(fake);
    const req = await requestPasswordReset(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');

    const result = await consumePasswordReset(req.token, NEW_PASSWORD, fake.db);

    expect(result.ok).toBe(true);
    // The credential's hash is now the NEW password's hash — old no longer works.
    expect(await verifyPassword(cred.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(cred.passwordHash, PASSWORD)).toBe(false);
    // The token is burned.
    expect(fake.tokens[0]?.usedAt).not.toBeNull();
  });

  it('rejects a replay of an already-used token (single use)', async () => {
    const fake = fakeDb();
    await seedVerified(fake);
    const req = await requestPasswordReset(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');

    await consumePasswordReset(req.token, NEW_PASSWORD, fake.db);
    const replay = await consumePasswordReset(req.token, 'yet another password', fake.db);

    expect(replay).toEqual({ ok: false, error: 'invalid_token' });
    // The replay did NOT overwrite the password again.
    expect(await verifyPassword(only(fake.creds).passwordHash, NEW_PASSWORD)).toBe(true);
  });

  it('rejects an expired token', async () => {
    const fake = fakeDb();
    await seedVerified(fake);
    const req = await requestPasswordReset(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');
    // Force the stored token past its expiry.
    only(fake.tokens).expiresAt = new Date(Date.now() - 1000);

    const result = await consumePasswordReset(req.token, NEW_PASSWORD, fake.db);

    expect(result).toEqual({ ok: false, error: 'invalid_token' });
    // Password unchanged.
    expect(await verifyPassword(only(fake.creds).passwordHash, PASSWORD)).toBe(true);
  });

  it('rejects an unknown token without touching any password', async () => {
    const fake = fakeDb();
    await seedVerified(fake);

    expect(await consumePasswordReset('not-a-real-token', NEW_PASSWORD, fake.db)).toEqual({
      ok: false,
      error: 'invalid_token',
    });
  });

  it('rejects a weak new password BEFORE burning the token (one-shot link preserved)', async () => {
    const fake = fakeDb();
    await seedVerified(fake);
    const req = await requestPasswordReset(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');

    const weak = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    const result = await consumePasswordReset(req.token, weak, fake.db);

    expect(result).toEqual({ ok: false, error: 'weak_password' });
    // The token is STILL usable — a fat-fingered weak password didn't waste it.
    expect(fake.tokens[0]?.usedAt).toBeNull();
    const retry = await consumePasswordReset(req.token, NEW_PASSWORD, fake.db);
    expect(retry.ok).toBe(true);
  });
});

describe('resendVerification — anti-enumeration', () => {
  it('mints a fresh token for an UNVERIFIED account', async () => {
    const fake = fakeDb();
    await registerCredential(EMAIL, PASSWORD, fake.db); // stays unverified
    const original = only(fake.creds).verificationToken;

    const result = await resendVerification(EMAIL, fake.db);

    expect(result.token).not.toBeNull();
    expect(result.token).not.toBe(original);
    expect(only(fake.creds).verificationToken).toBe(result.token);
  });

  it('returns the SAME null-token shape for a verified account and a missing one', async () => {
    const fake = fakeDb();
    await seedVerified(fake); // EMAIL is verified

    const verified = await resendVerification(EMAIL, fake.db);
    const missing = await resendVerification('nobody@example.com', fake.db);

    expect(verified.token).toBeNull();
    expect(missing.token).toBeNull();
    expect(Object.keys(verified).sort()).toEqual(Object.keys(missing).sort());
  });
});

describe('credentialUnverified — the sign-in split', () => {
  it('is TRUE only when the password is correct AND the email is unverified', async () => {
    const fake = fakeDb();
    await registerCredential(EMAIL, PASSWORD, fake.db); // unverified

    expect(await credentialUnverified(EMAIL, PASSWORD, fake.db)).toBe(true);
  });

  it('is FALSE for a wrong password on an unverified account (no verification leak to an attacker)', async () => {
    const fake = fakeDb();
    await registerCredential(EMAIL, PASSWORD, fake.db);

    expect(await credentialUnverified(EMAIL, 'wrong password', fake.db)).toBe(false);
  });

  it('is FALSE for a correct password on an already-verified account', async () => {
    const fake = fakeDb();
    await seedVerified(fake);

    expect(await credentialUnverified(EMAIL, PASSWORD, fake.db)).toBe(false);
  });

  it('is FALSE for an unknown email', async () => {
    const fake = fakeDb();
    await seedVerified(fake);

    expect(await credentialUnverified('nobody@example.com', PASSWORD, fake.db)).toBe(false);
  });
});
