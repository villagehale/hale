import type { Database } from '@hale/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptTokens, encryptTokens, type OAuthTokens } from './token-vault';
import {
  getConnectionTokens,
  listActiveConnectorConnections,
  markConnectionError,
  revokeConnection,
  saveConnection,
  saveConnectionCursor,
  saveConnectionTokensById,
} from './store';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TOKENS: OAuthTokens = { accessToken: 'ya29.secret-access', refreshToken: '1//secret-refresh' };

/**
 * Minimal Drizzle stand-in: `where()` is awaitable AND chainable to `.limit()` /
 * `.returning()`; `transaction(cb)` runs the callback against the same fake (the
 * connect/disconnect audit write shares the write's transaction). Inserts are
 * captured by column-shape: `cap.inserted` is the integration row (carries
 * `oauthTokensEncrypted`), `cap.audit` is the audit_log row (carries `actionTaken`).
 */
function fakeDb(selectRows: unknown[]) {
  const cap: {
    inserted?: Record<string, unknown>;
    audit?: Record<string, unknown>;
    updated?: Record<string, unknown>;
    selectWhere?: SQL;
    conflict?: { target: unknown; targetWhere?: unknown; set: Record<string, unknown> };
    /** Rows the revoke UPDATE ... RETURNING yields; defaults to one matched row. A
     * test sets this to [] to model a no-op revoke (nothing matched the key). */
    revokedRows?: { id: string }[];
  } = {};
  const returning = () => Promise.resolve([{ id: 'i1' }]);
  const updateReturning = () => Promise.resolve(cap.revokedRows ?? [{ id: 'i1' }]);
  const database = {
    select: () => ({
      from: () => ({
        where: (predicate: SQL) => {
          cap.selectWhere = predicate;
          return Object.assign(Promise.resolve(selectRows), { limit: () => Promise.resolve(selectRows) });
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        if ('actionTaken' in v) cap.audit = v;
        else cap.inserted = v;
        return Object.assign(Promise.resolve(), {
          returning,
          onConflictDoUpdate: (c: typeof cap.conflict) => {
            cap.conflict = c;
            return Object.assign(Promise.resolve(), { returning });
          },
        });
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        cap.updated = v;
        return { where: () => Object.assign(Promise.resolve(), { returning: updateReturning }) };
      },
    }),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(database),
  };
  return { database: database as unknown as Database, cap };
}

describe('integrations store', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('stores tokens ENCRYPTED, never as plaintext (rule #1)', async () => {
    const { database, cap } = fakeDb([]);
    await saveConnection(database, { familyId: FAMILY, userId: USER, provider: 'gcal', scopes: ['s'], tokens: TOKENS });
    const enc = cap.inserted?.oauthTokensEncrypted as string;
    expect(enc).toBeTruthy();
    expect(enc).not.toContain('secret-access'); // no plaintext token in the column
    expect(enc).not.toContain('secret-refresh');
    expect(decryptTokens(enc)).toEqual(TOKENS); // but it decrypts back
    expect(cap.inserted?.status).toBe('active');
    // rule #6: a connect writes an immutable audit row carrying provider + family,
    // never a token/email.
    expect(cap.audit?.actionTaken).toBe('integration_connected');
    expect(cap.audit?.familyId).toBe(FAMILY);
    expect(cap.audit?.actor).toBe(USER);
    expect(cap.audit?.after).toEqual({ provider: 'gcal' });
    expect(JSON.stringify(cap.audit)).not.toContain('secret');
  });

  it('upserts atomically on (family,user,provider) — no select-then-insert race', async () => {
    const { database, cap } = fakeDb([]);
    await saveConnection(database, { familyId: FAMILY, userId: USER, provider: 'gcal', scopes: ['s'], tokens: TOKENS });
    // A single ON CONFLICT DO UPDATE closes the two-callback dup-row window: two
    // concurrent connects for the same (family,user,provider) can no longer both
    // insert (double polling / double events).
    expect(cap.conflict).toBeDefined();
    const { sql } = new PgDialect().sqlToQuery(cap.conflict?.targetWhere as SQL);
    // Partial index (user_id NOT NULL) — the connect only conflicts on user-scoped rows.
    expect(sql).toContain('user_id');
    expect(sql).toContain('not null');
    // The refreshed tokens overwrite on conflict (re-connect re-encrypts).
    expect(cap.conflict?.set).toHaveProperty('oauthTokensEncrypted');
    expect(cap.conflict?.set).toHaveProperty('status');
  });

  it('decrypts tokens on read for an active connection', async () => {
    const enc = encryptTokens(TOKENS);
    const { database } = fakeDb([{ enc }]);
    expect(await getConnectionTokens(database, FAMILY, USER, 'gcal')).toEqual(TOKENS);
  });

  it('returns null when there is no active connection', async () => {
    const { database } = fakeDb([]);
    expect(await getConnectionTokens(database, FAMILY, USER, 'gmail')).toBeNull();
  });

  it('revoke purges the tokens, marks the row revoked, and returns the revoked count', async () => {
    const { database, cap } = fakeDb([]);
    const revoked = await revokeConnection(database, FAMILY, USER, 'gcal');
    expect(revoked).toBe(1);
    expect(cap.updated?.oauthTokensEncrypted).toBeNull();
    expect(cap.updated?.status).toBe('revoked');
    // rule #6: a disconnect writes an immutable audit row (provider + family only).
    expect(cap.audit?.actionTaken).toBe('integration_revoked');
    expect(cap.audit?.familyId).toBe(FAMILY);
    expect(cap.audit?.actor).toBe(USER);
    expect(cap.audit?.after).toEqual({ provider: 'gcal' });
  });

  it('revoke of a non-matching connection returns 0 and writes NO audit row (never a false success)', async () => {
    const { database, cap } = fakeDb([]);
    // Nothing matched the (family,user,provider) key — the UPDATE ... RETURNING is
    // empty. The caller must learn nothing was revoked, and no audit row is minted
    // (rule #6 rows only for real state changes).
    cap.revokedRows = [];
    const revoked = await revokeConnection(database, FAMILY, USER, 'gcal');
    expect(revoked).toBe(0);
    expect(cap.audit).toBeUndefined();
  });

  it('lists sweepable connections with the token blob OPAQUE (decryption is per-row, inside the sweep)', async () => {
    // The list must NOT decrypt: one corrupted blob would reject the whole
    // work-list. The blob it returns must still round-trip via decryptTokens.
    const enc = encryptTokens(TOKENS);
    const { database } = fakeDb([
      { id: 'i1', familyId: FAMILY, userId: USER, provider: 'gcal', providerMetadata: { syncToken: 't' }, enc },
    ]);
    const rows = await listActiveConnectorConnections(database);
    expect(rows).toEqual([
      { id: 'i1', familyId: FAMILY, userId: USER, provider: 'gcal', providerMetadata: { syncToken: 't' }, enc },
    ]);
    expect(decryptTokens(rows[0]?.enc as string)).toEqual(TOKENS);
  });

  it('sweeps BOTH active and errored connections (a transient error must self-heal), never revoked', async () => {
    const { database, cap } = fakeDb([]);
    await listActiveConnectorConnections(database);
    const { sql, params } = new PgDialect().sqlToQuery(cap.selectWhere as SQL);
    // The cursor of an errored row is intact, so retrying it is safe — the next
    // successful sync flips it back to active. Excluding it strands the family.
    expect(params).toContain('active');
    expect(params).toContain('error');
    expect(params).not.toContain('revoked');
    expect(sql).toContain('in (');
  });

  it('advances the cursor: writes providerMetadata + lastSyncAt, status stays active', async () => {
    const { database, cap } = fakeDb([]);
    const meta = { syncToken: 'next-token' };
    await saveConnectionCursor(database, 'i1', meta);
    expect(cap.updated?.providerMetadata).toEqual(meta);
    expect(cap.updated?.lastSyncAt).toBeInstanceOf(Date);
    expect(cap.updated?.status).toBe('active');
  });

  it('marks a connection errored WITHOUT touching the cursor', async () => {
    const { database, cap } = fakeDb([]);
    await markConnectionError(database, 'i1');
    expect(cap.updated?.status).toBe('error');
    // No cursor advance on error — providerMetadata/lastSyncAt untouched.
    expect(cap.updated).not.toHaveProperty('providerMetadata');
    expect(cap.updated).not.toHaveProperty('lastSyncAt');
  });

  it('re-encrypts refreshed tokens by id (never plaintext)', async () => {
    const { database, cap } = fakeDb([]);
    const refreshed: OAuthTokens = { accessToken: 'ya29.new-access', refreshToken: '1//secret-refresh' };
    await saveConnectionTokensById(database, 'i1', refreshed);
    const stored = cap.updated?.oauthTokensEncrypted as string;
    expect(stored).not.toContain('new-access');
    expect(decryptTokens(stored)).toEqual(refreshed);
  });
});
