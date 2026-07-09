import type { Database } from '@hale/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { consumeConnectNonce, mintConnectNonce } from './connect-nonce';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const NONCE = '33333333-3333-4333-8333-333333333333';

/** Minimal Drizzle stand-in capturing the insert row and the delete predicate;
 * `deleteRows` is what `.returning()` yields (0 rows → nonce not burned). */
function fakeDb(deleteRows: Array<{ id: string }>) {
  const cap: { inserted?: Record<string, unknown>; deleteWhere?: SQL } = {};
  const database = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        cap.inserted = v;
        return { returning: () => Promise.resolve([{ id: NONCE }]) };
      },
    }),
    delete: () => ({
      where: (predicate: SQL) => {
        cap.deleteWhere = predicate;
        return { returning: () => Promise.resolve(deleteRows) };
      },
    }),
  };
  return { database: database as unknown as Database, cap };
}

describe('connector connect nonce (mobile single-use binding)', () => {
  it('mints a nonce bound to the family with the given expiry', async () => {
    const { database, cap } = fakeDb([]);
    const expiresAt = new Date('2026-07-09T00:10:00Z');
    const id = await mintConnectNonce(database, FAMILY, expiresAt);
    expect(id).toBe(NONCE);
    expect(cap.inserted?.familyId).toBe(FAMILY);
    expect(cap.inserted?.expiresAt).toBe(expiresAt);
  });

  it('consume burns the nonce ONLY for the matching family AND before expiry', async () => {
    const { database, cap } = fakeDb([{ id: NONCE }]);
    const now = new Date('2026-07-09T00:05:00Z');
    const ok = await consumeConnectNonce(database, NONCE, FAMILY, now);
    expect(ok).toBe(true);
    const { sql, params } = new PgDialect().sqlToQuery(cap.deleteWhere as SQL);
    // The delete is scoped to id AND family AND unexpired — a nonce minted for
    // another family can't be consumed here, and an expired one is inert.
    expect(params).toContain(NONCE);
    expect(params).toContain(FAMILY);
    expect(sql).toContain('expires_at');
    expect(sql).toContain('>'); // gt(expiresAt, now)
  });

  it('consume returns false when no row is burned (already used / expired / wrong family)', async () => {
    const { database } = fakeDb([]); // returning() yields zero rows
    expect(await consumeConnectNonce(database, NONCE, FAMILY, new Date())).toBe(false);
  });
});
