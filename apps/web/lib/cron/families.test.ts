import type { Database } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { selectFamiliesNeedingDiscovery } from './families';

/**
 * selectFamiliesNeedingDiscovery gates the LIVE weekly discovery cron. Post-0051 a
 * family can have somewhere to discover for via an ACTIVE saved area alone (no
 * legacy families.area_coarse) — resolveActiveAreaCoarse resolves it — so the gate
 * must NOT be area_coarse-only, or such a family never receives standing discovery.
 * We capture the WHERE predicate and compile it to assert the widened gate, the
 * same idiom as integrations/connect-nonce.test.ts.
 */
function fakeDb() {
  const cap: { where?: SQL } = {};
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: (predicate: SQL) => {
      cap.where = predicate;
      return chain;
    },
    groupBy: () => chain,
    having: () => chain,
    orderBy: () => chain,
    limit: async () => [] as Array<{ id: string }>,
  };
  const database = { select: () => chain };
  return { database: database as unknown as Database, cap };
}

describe('selectFamiliesNeedingDiscovery — the discovery gate', () => {
  it('qualifies a family by a legacy area_coarse OR an active saved area (post-0051)', async () => {
    const { database, cap } = fakeDb();
    await selectFamiliesNeedingDiscovery(database, 10, new Date('2026-07-19T00:00:00Z'));

    const { sql } = new PgDialect().sqlToQuery(cap.where as SQL);
    // Still honors the legacy coarse field...
    expect(sql).toContain('area_coarse');
    // ...AND a family whose only area is a saved ACTIVE row (no legacy area_coarse).
    expect(sql).toContain('family_areas');
    expect(sql).toContain('is_active');
  });
});
