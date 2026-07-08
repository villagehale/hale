import { describe, expect, it, vi } from 'vitest';
import { readSavedVillageCandidates } from './saved-list.js';

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
    sourceUrl: 'https://ymca.ca/swim',
    source: 'web_grounded',
    confidence: 0.8,
    coverageNote: 'serves your area',
    lat: null,
    lng: null,
    venueName: null,
    venueAddress: null,
    shareToken: null,
    eventDate: null,
    seasons: null,
    runType: 'standing',
    searchSeason: null,
    supersededAt: null,
    discoveredAt: new Date('2026-07-04T12:00:00Z'),
    ...overrides,
  };
}

/**
 * Fakes the reads readSavedVillageCandidates runs, in order:
 *   1. children (for teen attribution)  → select().from().where()
 *   2. saved-join candidates            → select().from().innerJoin().where().orderBy()
 *   3. endorsement counts               → select().from().where().groupBy()  (skipped when 0 saved)
 *   4. family-endorsed candidate ids    → select().from().where()
 *   5. family-accepted candidate ids    → select().from().innerJoin().where()
 * The engagement reads (3-5) default to empty so a plain saved candidate reads as
 * not-endorsed / not-accepted; the accepted/endorsed tests override them.
 */
function fakeDb(opts: {
  children: unknown[];
  savedRows: unknown[];
  endorsementRows?: unknown[];
  endorsedRows?: unknown[];
  acceptedRows?: unknown[];
}) {
  // countEndorsementsForCandidates short-circuits (no select) when there are no
  // saved ids, so the engagement select order shifts by one in the empty case.
  const countsQueried = opts.savedRows.length > 0;
  const childrenChain = () => {
    const where = vi.fn().mockResolvedValue(opts.children);
    return { from: vi.fn().mockReturnValue({ where }) };
  };
  const savedChain = () => {
    const orderBy = vi.fn().mockResolvedValue(opts.savedRows);
    const where = vi.fn().mockReturnValue({ orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where });
    return { from: vi.fn().mockReturnValue({ innerJoin }) };
  };
  const countsChain = () => {
    const groupBy = vi.fn().mockResolvedValue(opts.endorsementRows ?? []);
    const where = vi.fn().mockReturnValue({ groupBy });
    return { from: vi.fn().mockReturnValue({ where }) };
  };
  const endorsedChain = () => {
    const where = vi.fn().mockResolvedValue(opts.endorsedRows ?? []);
    return { from: vi.fn().mockReturnValue({ where }) };
  };
  const acceptedChain = () => {
    const where = vi.fn().mockResolvedValue(opts.acceptedRows ?? []);
    const innerJoin = vi.fn().mockReturnValue({ where });
    return { from: vi.fn().mockReturnValue({ innerJoin }) };
  };

  const chains = [
    childrenChain,
    savedChain,
    ...(countsQueried ? [countsChain] : []),
    endorsedChain,
    acceptedChain,
  ];
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const chain = chains[call++];
    if (!chain) throw new Error(`fakeDb: unexpected select call #${call}`);
    return chain();
  });
  return { select } as never;
}

describe('readSavedVillageCandidates', () => {
  it('returns every saved candidate as a view with saved=true (drives the filled bookmark)', async () => {
    const db = fakeDb({
      children: [],
      savedRows: [{ candidate: candidateRow({ id: 'cand-1' }) }],
    });

    const views = await readSavedVillageCandidates(db, FAMILY_ID);

    expect(views).toHaveLength(1);
    expect(views[0]?.id).toBe('cand-1');
    expect(views[0]?.saved).toBe(true);
    expect(views[0]?.title).toBe('Parent & tot swim');
  });

  it('redacts a teen-attributed saved candidate (rule #1): category only, no raw title', async () => {
    const db = fakeDb({
      // The child is 13+ (born 2010) → teen; its saved candidate must be redacted.
      children: [{ id: TEEN_ID, dateOfBirth: '2010-01-01' }],
      savedRows: [
        { candidate: candidateRow({ id: 'cand-teen', childId: TEEN_ID, title: 'Teen LGBTQ+ group' }) },
      ],
    });

    const views = await readSavedVillageCandidates(db, FAMILY_ID);

    expect(views[0]?.teenAttributed).toBe(true);
    // The raw title never surfaces — only the category (kind) does.
    expect(views[0]?.title).not.toBe('Teen LGBTQ+ group');
    expect(views[0]?.kind).toBe('class');
    // Still saved (the flag is identity-free), so the bookmark shows filled.
    expect(views[0]?.saved).toBe(true);
  });

  it('reflects real engagement: a saved candidate already accepted/endorsed reads accepted+endorsed with its true count', async () => {
    const db = fakeDb({
      children: [],
      savedRows: [{ candidate: candidateRow({ id: 'cand-1' }) }],
      endorsementRows: [{ candidateId: 'cand-1', value: 3 }],
      endorsedRows: [{ candidateId: 'cand-1' }],
      // listFamilyAcceptedCandidateIds keeps only LIVE drafts (rule: honesty filter).
      acceptedRows: [
        { candidateId: 'cand-1', userVisibleState: 'drafted_for_approval', reviewerVerdict: 'approved' },
      ],
    });

    const views = await readSavedVillageCandidates(db, FAMILY_ID);

    expect(views[0]?.accepted).toBe(true);
    expect(views[0]?.endorsedByFamily).toBe(true);
    expect(views[0]?.endorsementCount).toBe(3);
  });

  it('returns an empty list when the family has saved nothing', async () => {
    const db = fakeDb({ children: [], savedRows: [] });
    expect(await readSavedVillageCandidates(db, FAMILY_ID)).toEqual([]);
  });
});
