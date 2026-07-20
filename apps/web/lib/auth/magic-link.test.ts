import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { credentialExternalAuthId } from './credentials';
import { consumeMagicLinkToken, requestMagicLink } from './magic-link';

/**
 * Security tests for the magic-link (passwordless) lifecycle. SHA-256 hashing is
 * REAL (node:crypto, no mock) so "only the hash is stored" and "the emailed token
 * hashes to the stored value" are genuine end-to-end assertions. The DB is a
 * two-table in-memory fake (magic_link_tokens + credentials) with real single-use
 * / expiry semantics, so single-use, atomicity, and find-or-create are real
 * assertions, not stubs. Only drizzle-orm's operators are mocked to plain markers
 * the fake interprets — the one seam needed to run the module's real queries.
 */
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ __op: 'eq', col, val }),
    isNull: (col: unknown) => ({ __op: 'isNull', col }),
    gt: (col: unknown, val: unknown) => ({ __op: 'gt', col, val }),
    and: (...clauses: unknown[]) => ({ __op: 'and', clauses }),
  };
});

interface TokenRow {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

interface CredRow {
  id: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  verificationToken: string | null;
  verificationSentAt: Date | null;
  createdAt: Date;
}

type Marker =
  | { __op: 'eq'; col: unknown; val: unknown }
  | { __op: 'isNull'; col: unknown }
  | { __op: 'gt'; col: unknown; val: unknown }
  | { __op: 'and'; clauses: Marker[] };

const TOKEN_COLS = new Map<unknown, keyof TokenRow>([
  [schema.magicLinkTokens.id, 'id'],
  [schema.magicLinkTokens.email, 'email'],
  [schema.magicLinkTokens.tokenHash, 'tokenHash'],
  [schema.magicLinkTokens.expiresAt, 'expiresAt'],
  [schema.magicLinkTokens.consumedAt, 'consumedAt'],
]);
const CRED_COLS = new Map<unknown, keyof CredRow>([
  [schema.credentials.id, 'id'],
  [schema.credentials.email, 'email'],
  [schema.credentials.emailVerifiedAt, 'emailVerifiedAt'],
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
  if (marker.__op === 'gt') {
    return (r) => (r[key] as unknown as Date) > (marker.val as Date);
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

/**
 * A fake spanning BOTH tables. The current table is picked per-statement from the
 * schema object passed to insert()/update(), and from the projected columns on
 * select().
 */
function fakeDb(): { db: Database; tokens: TokenRow[]; creds: CredRow[] } {
  const tokens: TokenRow[] = [];
  const creds: CredRow[] = [];
  let tokenCounter = 0;
  let credCounter = 0;

  function isTokenProjection(cols: Record<string, unknown>): boolean {
    return Object.values(cols).some((c) => TOKEN_COLS.has(c));
  }

  const db = {
    insert(table: unknown) {
      const isToken = table === schema.magicLinkTokens;
      return {
        values(v: Record<string, unknown>) {
          if (isToken) {
            tokenCounter += 1;
            tokens.push({
              id: `mlt-${tokenCounter}`,
              email: v.email as string,
              tokenHash: v.tokenHash as string,
              expiresAt: v.expiresAt as Date,
              consumedAt: (v.consumedAt as Date) ?? null,
              createdAt: new Date(),
            });
            return thenable([]);
          }
          // credentials insert (find-or-create)
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
                    emailVerifiedAt: (v.emailVerifiedAt as Date) ?? null,
                    verificationToken: (v.verificationToken as string) ?? null,
                    verificationSentAt: (v.verificationSentAt as Date) ?? null,
                    createdAt: new Date(),
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
      const isToken = isTokenProjection(cols);
      return {
        from() {
          return {
            where(marker: Marker) {
              return {
                limit(n: number) {
                  const rowsOut = isToken
                    ? tokens.filter(predicate(TOKEN_COLS, marker)).slice(0, n).map((r) => project(r, cols))
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
      const isToken = table === schema.magicLinkTokens;
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(marker: Marker) {
              const store = isToken ? tokens : creds;
              const cols = isToken ? TOKEN_COLS : CRED_COLS;
              // biome-ignore lint/suspicious/noExplicitAny: the fake stores mixed rows
              const match = (store as any[]).filter(predicate(cols as never, marker));
              for (const r of match) Object.assign(r, patch);
              const burned = match.map((r) => project(r, { email: schema.magicLinkTokens.email }));
              return {
                // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable
                then: (resolve: (v: unknown[]) => unknown) => resolve([]),
                returning() {
                  return thenable(burned);
                },
              };
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as Database, tokens, creds };
}

function seedCred(fake: ReturnType<typeof fakeDb>, email: string, verified: boolean): CredRow {
  const row: CredRow = {
    id: `seed-${fake.creds.length + 1}`,
    email,
    passwordHash: 'seed-hash',
    emailVerifiedAt: verified ? new Date() : null,
    verificationToken: null,
    verificationSentAt: null,
    createdAt: new Date(),
  };
  fake.creds.push(row);
  return row;
}

const EMAIL = 'parent@example.com';
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

describe('requestMagicLink — mint + anti-enumeration', () => {
  it('mints a token for ANY valid email — account existing or not (enumeration-safe)', async () => {
    const fake = fakeDb();
    seedCred(fake, 'has-account@example.com', true);

    const existing = await requestMagicLink('has-account@example.com', fake.db);
    const brandNew = await requestMagicLink('never-seen@example.com', fake.db);

    // Identical shape and both mint — the request path can't be used to probe which
    // addresses have accounts, because a magic link doubles as sign-up.
    expect(existing.token).not.toBeNull();
    expect(brandNew.token).not.toBeNull();
    expect(Object.keys(existing).sort()).toEqual(Object.keys(brandNew).sort());
    expect(fake.tokens).toHaveLength(2);
  });

  it('stores only the SHA-256 hash, never the raw token (rule #1)', async () => {
    const fake = fakeDb();
    const result = await requestMagicLink(EMAIL, fake.db);
    const raw = result.token;
    expect(raw).not.toBeNull();
    const stored = fake.tokens[0];
    if (!raw || !stored) throw new Error('expected a token');
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.tokenHash).not.toContain(raw);
    expect(stored.tokenHash).toBe(sha256(raw));
    expect(stored.email).toBe(EMAIL);
  });

  it('normalizes the email and rejects a malformed one without minting', async () => {
    const fake = fakeDb();

    const upper = await requestMagicLink('  Parent@Example.COM ', fake.db);
    expect(upper.email).toBe(EMAIL);
    expect(upper.token).not.toBeNull();

    const bad = await requestMagicLink('not-an-email', fake.db);
    expect(bad.token).toBeNull();
    // Only the valid request minted a row.
    expect(fake.tokens).toHaveLength(1);
  });

  it('invalidates a prior unconsumed token when a new one is requested', async () => {
    const fake = fakeDb();
    await requestMagicLink(EMAIL, fake.db);
    await requestMagicLink(EMAIL, fake.db);

    const live = fake.tokens.filter((t) => t.consumedAt == null);
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(fake.tokens[1]);
  });
});

describe('consumeMagicLinkToken — single-use, expiring, find-or-create', () => {
  it('mint -> consume happy path returns the credentials identity and burns the token', async () => {
    const fake = fakeDb();
    const cred = seedCred(fake, EMAIL, true);
    const req = await requestMagicLink(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');

    const result = await consumeMagicLinkToken(req.token, fake.db);

    expect(result).toEqual({
      ok: true,
      // Derived from the credentials contract, NOT copied from output.
      identity: { id: credentialExternalAuthId(cred.id), email: EMAIL },
    });
    // Existing account unified — no duplicate credential created.
    expect(fake.creds).toHaveLength(1);
    // Token burned.
    expect(fake.tokens[0]?.consumedAt).not.toBeNull();
  });

  it('creates a verified credential when the email has no account (sign-up)', async () => {
    const fake = fakeDb();
    const req = await requestMagicLink('newcomer@example.com', fake.db);
    if (!req.token) throw new Error('expected a token');

    const result = await consumeMagicLinkToken(req.token, fake.db);

    expect(result.ok).toBe(true);
    expect(fake.creds).toHaveLength(1);
    const created = fake.creds[0];
    if (!created) throw new Error('expected a credential');
    expect(created.email).toBe('newcomer@example.com');
    // Email is pre-verified (the link proves ownership) and a password hash exists
    // (an unusable sentinel — the account has no password until it sets one).
    expect(created.emailVerifiedAt).not.toBeNull();
    expect(created.passwordHash.length).toBeGreaterThan(0);
    if (result.ok) {
      expect(result.identity.id).toBe(credentialExternalAuthId(created.id));
    }
  });

  it('marks an existing UNVERIFIED credential verified (the link proves ownership)', async () => {
    const fake = fakeDb();
    const cred = seedCred(fake, EMAIL, false);
    const req = await requestMagicLink(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');

    await consumeMagicLinkToken(req.token, fake.db);

    expect(cred.emailVerifiedAt).not.toBeNull();
    expect(fake.creds).toHaveLength(1);
  });

  it('rejects a replay of an already-consumed token (single use, atomic)', async () => {
    const fake = fakeDb();
    seedCred(fake, EMAIL, true);
    const req = await requestMagicLink(EMAIL, fake.db);
    if (!req.token) throw new Error('expected a token');

    const first = await consumeMagicLinkToken(req.token, fake.db);
    const replay = await consumeMagicLinkToken(req.token, fake.db);

    expect(first.ok).toBe(true);
    expect(replay).toEqual({ ok: false });
    // The replay neither re-consumed nor created a second credential.
    expect(fake.creds).toHaveLength(1);
  });

  it('rejects an expired token without creating any account', async () => {
    const fake = fakeDb();
    const req = await requestMagicLink('someone@example.com', fake.db);
    if (!req.token) throw new Error('expected a token');
    const stored = fake.tokens[0];
    if (!stored) throw new Error('expected a token row');
    stored.expiresAt = new Date(Date.now() - 1000);

    const result = await consumeMagicLinkToken(req.token, fake.db);

    expect(result).toEqual({ ok: false });
    expect(fake.creds).toHaveLength(0);
    // An expired token is NOT burned by a redeem attempt — the WHERE never matched.
    expect(stored.consumedAt).toBeNull();
  });

  it('rejects an unknown / empty token', async () => {
    const fake = fakeDb();
    expect(await consumeMagicLinkToken('', fake.db)).toEqual({ ok: false });
    expect(await consumeMagicLinkToken('not-a-real-token', fake.db)).toEqual({ ok: false });
    expect(fake.creds).toHaveLength(0);
  });
});
