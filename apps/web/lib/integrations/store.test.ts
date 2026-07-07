import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptTokens, encryptTokens, type OAuthTokens } from './token-vault';
import { getConnectionTokens, revokeConnection, saveConnection } from './store';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TOKENS: OAuthTokens = { accessToken: 'ya29.secret-access', refreshToken: '1//secret-refresh' };

/** Minimal Drizzle stand-in: `where()` is awaitable AND chainable to `.limit()`. */
function fakeDb(selectRows: unknown[]) {
  const cap: { inserted?: Record<string, unknown>; updated?: Record<string, unknown> } = {};
  const database = {
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve(selectRows), { limit: () => Promise.resolve(selectRows) }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        cap.inserted = v;
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          cap.updated = v;
          return Promise.resolve();
        },
      }),
    }),
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
    const { database, cap } = fakeDb([]); // no existing row → insert path
    await saveConnection(database, { familyId: FAMILY, userId: USER, provider: 'gcal', scopes: ['s'], tokens: TOKENS });
    const enc = cap.inserted?.oauthTokensEncrypted as string;
    expect(enc).toBeTruthy();
    expect(enc).not.toContain('secret-access'); // no plaintext token in the column
    expect(enc).not.toContain('secret-refresh');
    expect(decryptTokens(enc)).toEqual(TOKENS); // but it decrypts back
    expect(cap.inserted?.status).toBe('active');
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

  it('revoke purges the tokens and marks the row revoked', async () => {
    const { database, cap } = fakeDb([]);
    await revokeConnection(database, FAMILY, USER, 'gcal');
    expect(cap.updated?.oauthTokensEncrypted).toBeNull();
    expect(cap.updated?.status).toBe('revoked');
  });
});
