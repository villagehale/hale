import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * loadAuthoredPlans reads env + db directly, so this test injects a fake db (via
 * the ~/lib/db mock) that records the orderBy chunks and returns one row. The point
 * is the CHRONOLOGICAL contract: the primary sort key is scheduled_for ASC (soonest
 * day first, for the Mon–Sun spine), NOT created_at — the bug this change fixes.
 */

let orderByArgs: SQL[] = [];

function fakeDb() {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn((...args: SQL[]) => {
      orderByArgs = args;
      return Promise.resolve([
        {
          id: 'p1',
          title: 't',
          notes: null,
          scheduledFor: new Date('2026-07-01T00:00:00.000Z'),
          completedAt: null,
          childId: null,
          childName: null,
        },
      ]);
    }),
  };
  return chain;
}

vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => 'fam-1' }));

/** Serializes an asc()/desc() SQL fragment to the "<column> asc|desc" text drizzle
 * emits, so the test can assert the column AND the direction without a live DB. */
function sqlText(fragment: SQL): string {
  const chunks = (fragment as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((c) => {
      if (c && typeof c === 'object' && 'name' in c) return String((c as { name: string }).name);
      if (c && typeof c === 'object' && 'value' in c) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return '';
    })
    .join('')
    .trim();
}

describe('loadAuthoredPlans — chronological ordering', () => {
  beforeEach(() => {
    orderByArgs = [];
    process.env.DATABASE_URL = 'postgres://test';
  });
  afterEach(() => {
    process.env.DATABASE_URL = undefined;
    vi.resetModules();
  });

  it('orders by scheduled_for ASC as the primary key, created_at DESC as the tie-break', async () => {
    const { loadAuthoredPlans } = await import('./authored.js');
    await loadAuthoredPlans();

    expect(orderByArgs).toHaveLength(2);
    const primary = sqlText(orderByArgs[0] as SQL);
    const tiebreak = sqlText(orderByArgs[1] as SQL);
    expect(primary).toBe('scheduled_for asc');
    expect(tiebreak).toBe('created_at desc');
  });

  it('maps completedAt through to the view (drives settling on the page)', async () => {
    const { loadAuthoredPlans } = await import('./authored.js');
    const rows = await loadAuthoredPlans();
    expect(rows[0]?.completedAt).toBeNull();
    expect(rows[0]?.scheduledFor).toBe('2026-07-01T00:00:00.000Z');
  });
});
