import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * loadFamilyBasics runs a families + children read. The authed layout AND the page
 * inside it both call it in one request, so without per-request memoization the pair
 * of queries fires twice. This asserts the loader is routed through React's cache():
 * with cache in play, two calls collapse to a single DB read.
 *
 * React's cache() only dedupes inside the RSC request scope (proven: it does not
 * dedupe under vitest or react-dom/server), so we mock `react`'s cache with a
 * deterministic memoizer and assert loadFamilyBasics is actually passed through it —
 * a red-before-green guard on the wrap itself. Before the wrap, two calls hit the DB
 * twice regardless of the mock; after it, once.
 */

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    // A no-arg memoizer — enough to stand in for React's per-request cache here.
    cache: <T extends (...args: never[]) => unknown>(fn: T): T => {
      let called = false;
      let value: unknown;
      return ((...args: never[]) => {
        if (!called) {
          called = true;
          value = fn(...args);
        }
        return value;
      }) as T;
    },
  };
});

vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn().mockResolvedValue('fam-1') }));
vi.mock('~/lib/db', () => ({ db: vi.fn() }));

const FAMILY_ROW = {
  country: 'CA',
  province: null,
  city: null,
  postalCode: null,
  planTier: 'plus',
  intents: null,
  foundingNumber: null,
};

let familyReads = 0;

function fakeDb() {
  return {
    select: (proj: Record<string, unknown>) => {
      const keys = Object.keys(proj ?? {});
      if (keys.includes('planTier')) {
        familyReads++;
        return { from: () => ({ where: () => ({ limit: async () => [FAMILY_ROW] }) }) };
      }
      // children read
      return { from: () => ({ where: () => ({ orderBy: async () => [] }) }) };
    },
  };
}

let loadFamilyBasics: typeof import('./queries.js').loadFamilyBasics;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://test';
  const { db } = await import('~/lib/db');
  (db as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => fakeDb());
  ({ loadFamilyBasics } = await import('./queries.js'));
});

afterAll(() => {
  process.env.DATABASE_URL = undefined;
});

describe('loadFamilyBasics per-request memoization', () => {
  it('runs the families read once across two calls in a request', async () => {
    familyReads = 0;
    const first = await loadFamilyBasics();
    const second = await loadFamilyBasics();

    expect(familyReads).toBe(1);
    // The refactor still returns the real mapped data on both calls.
    expect(first.planTier).toBe('plus');
    expect(second.planTier).toBe('plus');
  });
});
