import { describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';

// readVillageCandidateById takes the `database` directly and never resolves the
// family/session, but importing queries.ts otherwise loads ~/lib/family → ~/auth →
// next-auth (which fails to resolve in the test env). Stub that boundary so the pure
// query function loads in isolation; the test never calls currentFamilyId.
vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn() }));

const { readVillageCandidateById } = await import('./queries.js');

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TEEN_ID = '99999999-9999-4999-8999-999999999999';

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cand-1',
    familyId: FAMILY_ID,
    childId: null,
    title: 'Parent & tot swim',
    kind: 'class',
    cadence: 'ongoing',
    summary: 'A weekly drop-in swim.',
    coverageNote: 'serves your area',
    sourceUrl: 'https://ymca.ca/swim',
    lat: 43.65,
    lng: -79.38,
    venueName: 'Georgetown YMCA',
    rating: '4.6',
    ratingCount: 42,
    priceLevel: 'low',
    ageRange: 'Ages 0–4',
    indoorOutdoor: 'indoor',
    eventDate: null,
    seasons: null,
    discoveredAt: new Date('2026-07-04T12:00:00Z'),
    ...overrides,
  };
}

/**
 * Fakes the reads readVillageCandidateById runs, in call order:
 *   1. the candidate by id + familyId         → select().from().where().limit()
 *   2. isTeenChild (only when childId != null) → select().from().where().limit()
 *   3. endorsement counts                      → select().from().where().groupBy()
 *   4. family-endorsed candidate ids           → select().from().where()
 *   5. family-accepted candidate ids           → select().from().innerJoin().where()
 *   6. family-saved candidate ids              → select().from().where()
 * The engagement reads (3-6) default to empty; the redaction/scoping tests don't
 * exercise them. An empty candidate result returns null before chain 2 is reached.
 */
function fakeDb(opts: {
  candidateRows: unknown[];
  children?: unknown[];
  endorsementRows?: unknown[];
  endorsedRows?: unknown[];
  acceptedRows?: unknown[];
  savedRows?: unknown[];
}) {
  const limitChain = (rows: unknown[]) => {
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    return { from: vi.fn().mockReturnValue({ where }) };
  };
  const whereChain = (rows: unknown[]) => {
    const where = vi.fn().mockResolvedValue(rows);
    return { from: vi.fn().mockReturnValue({ where }) };
  };
  const groupByChain = (rows: unknown[]) => {
    const groupBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ groupBy });
    return { from: vi.fn().mockReturnValue({ where }) };
  };
  const innerJoinChain = (rows: unknown[]) => {
    const where = vi.fn().mockResolvedValue(rows);
    const innerJoin = vi.fn().mockReturnValue({ where });
    return { from: vi.fn().mockReturnValue({ innerJoin }) };
  };

  const chains = [
    () => limitChain(opts.candidateRows),
    () => limitChain(opts.children ?? []),
    () => groupByChain(opts.endorsementRows ?? []),
    () => whereChain(opts.endorsedRows ?? []),
    () => innerJoinChain(opts.acceptedRows ?? []),
    () => whereChain(opts.savedRows ?? []),
  ];
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const chain = chains[call++];
    if (!chain) throw new Error(`fakeDb: unexpected select call #${call}`);
    return chain();
  });
  return { select } as never;
}

describe('readVillageCandidateById', () => {
  it('redacts a teen-attributed candidate (rule #1): placeholder title, empty summary, no coords', async () => {
    const db = fakeDb({
      candidateRows: [
        candidateRow({
          id: 'cand-teen',
          childId: TEEN_ID,
          title: 'Teen support group',
          summary: 'A weekly peer group for LGBTQ+ teens.',
        }),
      ],
      // The child is 13+ (born 2010) → teen; its candidate must be redacted.
      children: [{ dateOfBirth: '2010-01-01' }],
    });

    const view = await readVillageCandidateById(db, FAMILY_ID, 'cand-teen');

    expect(view).not.toBeNull();
    expect(view?.teenAttributed).toBe(true);
    // The raw content never surfaces — only the category (kind) does (rule #1).
    expect(view?.title).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view?.title).not.toBe('Teen support group');
    expect(view?.summary).toBe('');
    expect(view?.lat).toBeNull();
    expect(view?.lng).toBeNull();
    expect(view?.venueName).toBeNull();
    expect(view?.rating).toBeNull();
    // Category is the one thing a redacted card keeps.
    expect(view?.kind).toBe('class');
  });

  it('returns null when no row is found', async () => {
    // The candidate select resolves empty, so the function returns null before
    // touching engagement. (This fake ignores the WHERE predicate, so it does NOT
    // prove family scoping — the real cross-family probe is a Phase E live-QA case.)
    const db = fakeDb({ candidateRows: [] });

    const view = await readVillageCandidateById(db, FAMILY_ID, 'no-such-candidate');

    expect(view).toBeNull();
  });
});
