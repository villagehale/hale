import { describe, expect, it } from 'vitest';
import {
  type IntroCandidateFamily,
  eligibleAnchorChildren,
  matchIntroPairs,
  normalizeFsa,
} from './matcher';

const NOW = new Date('2026-08-11T14:00:00Z');

/** Two ids whose lexicographic order is obvious, so the a<b invariant is readable. */
const AAA = '11111111-1111-4111-8111-111111111111';
const BBB = '22222222-2222-4222-8222-222222222222';
const CCC = '33333333-3333-4333-8333-333333333333';

function family(overrides: Partial<IntroCandidateFamily> & { familyId: string }): IntroCandidateFamily {
  return {
    parentUserId: `user-${overrides.familyId}`,
    fsa: 'M4K',
    parentEmail: 'parent@example.com',
    parentName: 'Sam Lee',
    // Born 2024-02-11 -> 30 months at NOW -> toddler.
    children: [{ id: `child-${overrides.familyId}`, dateOfBirth: '2024-02-11' }],
    ...overrides,
  };
}

describe('normalizeFsa', () => {
  it('takes the forward sortation area out of a full Canadian postal code', () => {
    expect(normalizeFsa('M4K 1N2')).toBe('M4K');
    expect(normalizeFsa('m4k1n2')).toBe('M4K');
  });

  it('accepts a bare FSA', () => {
    expect(normalizeFsa('L6H')).toBe('L6H');
  });

  it('refuses anything that is not FSA-shaped - a city is not a locality match', () => {
    // areaCoarse falls back to the CITY when a family has no postal code, and a city is
    // a far wider net than "near you". FSA-level matching only (rule #1).
    expect(normalizeFsa('Toronto')).toBeNull();
    expect(normalizeFsa('North York')).toBeNull();
    expect(normalizeFsa('90210')).toBeNull();
    expect(normalizeFsa('')).toBeNull();
    expect(normalizeFsa(null)).toBeNull();
  });
});

describe('eligibleAnchorChildren', () => {
  it('derives each childs stage live from the date of birth', () => {
    const children = eligibleAnchorChildren(
      [
        { id: 'a', dateOfBirth: '2026-03-11' }, // 5 months -> newborn
        { id: 'b', dateOfBirth: '2024-02-11' }, // 30 months -> toddler
        { id: 'c', dateOfBirth: '2021-08-11' }, // 60 months -> child
      ],
      NOW,
    );
    expect(children).toEqual([
      { id: 'a', stage: 'newborn' },
      { id: 'b', stage: 'toddler' },
      { id: 'c', stage: 'child' },
    ]);
  });

  it('excludes 13+ children at the SOURCE, not as a redaction on the way out', () => {
    const children = eligibleAnchorChildren(
      [
        { id: 'teen', dateOfBirth: '2012-01-01' },
        { id: 'kid', dateOfBirth: '2024-02-11' },
      ],
      NOW,
    );
    expect(children.map((c) => c.id)).toEqual(['kid']);
  });

  it('excludes a child on the very day they turn 13', () => {
    expect(eligibleAnchorChildren([{ id: 't', dateOfBirth: '2013-08-11' }], NOW)).toEqual([]);
  });
});

describe('matchIntroPairs', () => {
  it('pairs exactly two opted-in families sharing an FSA and a stage band', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([
      {
        familyAId: AAA,
        familyBId: BBB,
        familyAChildId: `child-${AAA}`,
        familyBChildId: `child-${BBB}`,
        fsa: 'M4K',
        stage: 'toddler',
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('stores the pair in id order so the same two families cannot be stored twice', () => {
    const result = matchIntroPairs({
      // Deliberately reversed on the way in.
      families: [family({ familyId: BBB }), family({ familyId: AAA })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings[0]?.familyAId).toBe(AAA);
    expect(result.pairings[0]?.familyBId).toBe(BBB);
  });

  it('does not pair a lone family in an FSA', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
  });

  it('never crosses an FSA boundary', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA, fsa: 'M4K' }), family({ familyId: BBB, fsa: 'L6H' })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
  });

  it('requires an overlapping stage band, not merely a shared FSA', () => {
    const result = matchIntroPairs({
      families: [
        family({ familyId: AAA, children: [{ id: 'baby', dateOfBirth: '2026-05-11' }] }),
        family({ familyId: BBB, children: [{ id: 'big', dateOfBirth: '2018-01-01' }] }),
      ],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('skips a family with no parent email, and says so by name', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB, parentEmail: null })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
    expect(result.skipped).toEqual([{ familyId: BBB, reason: 'no_parent_email' }]);
  });

  it('skips a family whose area is not an FSA, and says so by name', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB, fsa: 'Toronto' })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
    expect(result.skipped).toEqual([{ familyId: BBB, reason: 'no_fsa' }]);
  });

  it('skips a family with no display name - an intro cannot greet a nameless parent', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB, parentName: null })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
    expect(result.skipped).toEqual([{ familyId: BBB, reason: 'no_parent_name' }]);
  });

  it('skips a family whose only child is a teenager', () => {
    const result = matchIntroPairs({
      families: [
        family({ familyId: AAA }),
        family({ familyId: BBB, children: [{ id: 'teen', dateOfBirth: '2011-01-01' }] }),
      ],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
    expect(result.skipped).toEqual([{ familyId: BBB, reason: 'no_matchable_child' }]);
  });

  it('never re-proposes a pair that has already been declined', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set([`${AAA}:${BBB}`]),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
  });

  it('leaves a family alone while it already has an open proposal', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB }), family({ familyId: CCC })],
      familiesWithOpenProposal: new Set([AAA]),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([
      expect.objectContaining({ familyAId: BBB, familyBId: CCC }),
    ]);
  });

  it('gives each family at most one new proposal per run', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB }), family({ familyId: CCC })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toHaveLength(1);
    expect(result.pairings[0]).toEqual(
      expect.objectContaining({ familyAId: AAA, familyBId: BBB }),
    );
  });

  it('anchors each side on its OWN oldest child inside the shared band', () => {
    const result = matchIntroPairs({
      families: [
        family({
          familyId: AAA,
          children: [
            { id: 'younger', dateOfBirth: '2024-06-01' },
            { id: 'older', dateOfBirth: '2023-06-01' },
          ],
        }),
        family({ familyId: BBB }),
      ],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings[0]?.familyAChildId).toBe('older');
  });

  it('prefers the earliest shared band in childhood order when two overlap', () => {
    const both = [
      { id: 'tot', dateOfBirth: '2024-02-11' }, // toddler
      { id: 'big', dateOfBirth: '2019-02-11' }, // child
    ];
    const result = matchIntroPairs({
      families: [
        family({ familyId: AAA, children: both.map((c) => ({ ...c, id: `a-${c.id}` })) }),
        family({ familyId: BBB, children: both.map((c) => ({ ...c, id: `b-${c.id}` })) }),
      ],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings[0]).toEqual(
      expect.objectContaining({ stage: 'toddler', familyAChildId: 'a-tot', familyBChildId: 'b-tot' }),
    );
  });
});
