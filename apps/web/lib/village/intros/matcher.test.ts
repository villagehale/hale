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
const DDD = '44444444-4444-4444-8444-444444444444';

/** One opaque `host:courseId`, as {@link IntroCandidateFamily.classKeys} carries it. */
const COURSE = 'cityofmarkham.perfectmind.com:22222222-2222-2222-2222-222222222222';
const OTHER_COURSE = 'townofoakville.perfectmind.com:33333333-3333-3333-3333-333333333333';

function family(overrides: Partial<IntroCandidateFamily> & { familyId: string }): IntroCandidateFamily {
  return {
    parentUserId: `user-${overrides.familyId}`,
    fsa: 'M4K',
    // Born 2024-02-11 -> 30 months at NOW -> toddler.
    children: [{ id: `child-${overrides.familyId}`, dateOfBirth: '2024-02-11' }],
    classKeys: new Set(),
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
        signal: 'same_area',
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

  /**
   * The regression that stalled two real families. Both had arrived by text, so neither
   * had a name or an address on file, and the matcher used to refuse the pair outright —
   * which meant they were each asked "want an introduction?", both said yes, and nothing
   * ever happened to either of them. Neither fact is a matching input: the card is worded
   * from the recipient's OWN child and a stage word. They belong to the handoff, where
   * Hale can ask for them.
   */
  it('pairs two families that have no parent name and no email - identity is the handoff\'s business', () => {
    const result = matchIntroPairs({
      families: [family({ familyId: AAA }), family({ familyId: BBB })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toHaveLength(1);
    expect(result.skipped).toEqual([]);
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

/**
 * The match radius (2026-08-12). FSA-exact was too narrow outside Toronto: Halton Hills
 * is L7G (Georgetown) plus L7J (Acton), two FSAs of one small town whose families share
 * one recreation department and one set of school-holiday camps. Toronto is the opposite
 * case — one municipality of three million — so it stays FSA-exact.
 *
 * WHAT DID NOT CHANGE: the coarse card. This decides who may be PAIRED, never what is
 * disclosed; no card, email or audit row names an area either way.
 */
describe('matchIntroPairs across a municipality', () => {
  function pairOf(fsaA: string, fsaB: string) {
    return matchIntroPairs({
      families: [family({ familyId: AAA, fsa: fsaA }), family({ familyId: BBB, fsa: fsaB })],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    }).pairings;
  }

  it('pairs Georgetown with Acton - two FSAs, one Halton Hills', () => {
    expect(pairOf('L7G', 'L7J')).toEqual([
      expect.objectContaining({ familyAId: AAA, familyBId: BBB, stage: 'toddler' }),
    ]);
  });

  it('stores family A’s own FSA on the pair, not the municipality', () => {
    // The proposal row's `fsa` column is a real FSA and stays one. It records where the
    // pair was anchored; it is not a claim that both households live in it.
    expect(pairOf('L7G', 'L7J')[0]?.fsa).toBe('L7G');
    expect(pairOf('L7J', 'L7G')[0]?.fsa).toBe('L7J');
  });

  it('keeps Toronto FSA-exact - one M bucket would be a city of three million', () => {
    expect(pairOf('M4K', 'M4J')).toEqual([]);
    expect(pairOf('M4K', 'M4K')).toHaveLength(1);
  });

  it('does not pair across two municipalities that merely border each other', () => {
    // L7G is Halton Hills, L6H is Oakville. Adjacent towns are not one radius.
    expect(pairOf('L7G', 'L6H')).toEqual([]);
  });

  it('fails closed on an unmapped FSA: exact-FSA only, never a guessed town', () => {
    // K1A is Ottawa - outside the covered set entirely. It may still match itself, which
    // is exactly today's behaviour; what it may never do is widen to a municipality.
    expect(pairOf('K1A', 'K1A')).toHaveLength(1);
    expect(pairOf('K1A', 'K1B')).toEqual([]);
  });

  it('fails closed when only one side of the pair is mapped', () => {
    expect(pairOf('L7G', 'K1A')).toEqual([]);
  });

  it('fails closed on an FSA that straddles two municipalities', () => {
    // L3T is Thornhill, split down Yonge Street between Markham and Vaughan and recorded
    // as both. "Probably Markham" is a guess, and a guess is not a radius: L3T matches
    // only L3T. L3R is Markham proper.
    expect(pairOf('L3T', 'L3R')).toEqual([]);
    expect(pairOf('L3T', 'L4J')).toEqual([]);
    expect(pairOf('L3T', 'L3T')).toHaveLength(1);
  });

  it('still refuses a city-fallback area by name, whatever the radius', () => {
    // `families.area_coarse` falls back to the CITY, and "Toronto" is not a locality
    // match at any grain (#410, non-negotiable 3).
    const result = matchIntroPairs({
      families: [
        family({ familyId: AAA, fsa: 'Toronto' }),
        family({ familyId: BBB, fsa: 'Toronto' }),
      ],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
    expect(result.skipped).toEqual([
      { familyId: AAA, reason: 'no_fsa' },
      { familyId: BBB, reason: 'no_fsa' },
    ]);
  });

  it('still requires an overlapping stage band across the wider radius', () => {
    const result = matchIntroPairs({
      families: [
        family({ familyId: AAA, fsa: 'L7G', children: [{ id: 'baby', dateOfBirth: '2026-05-11' }] }),
        family({ familyId: BBB, fsa: 'L7J', children: [{ id: 'big', dateOfBirth: '2018-01-01' }] }),
      ],
      familiesWithOpenProposal: new Set(),
      pairedBefore: new Set(),
      now: NOW,
    });
    expect(result.pairings).toEqual([]);
  });
});

/**
 * VIL-340 · the same-class signal, which RANKS and never speaks. A key is an opaque
 * `host:courseId` the caller derived from the family's own live watched spots; this file
 * only ever compares them.
 *
 * Every case below also pins what the signal may NOT do: cross an area, override a band,
 * or reopen a burned pair. A rank that could do any of those would be a second matching
 * rule wearing a preference's clothes.
 */
describe('matchIntroPairs and the same-class signal', () => {
  function pairs(families: IntroCandidateFamily[], pairedBefore = new Set<string>()) {
    return matchIntroPairs({
      families,
      familiesWithOpenProposal: new Set(),
      pairedBefore,
      now: NOW,
    }).pairings;
  }

  /** Catches the first-fit walk surviving unchanged: it would pair AAA with BBB. */
  it('prefers the partner sharing a class key over the first-fit neighbour', () => {
    expect(
      pairs([
        family({ familyId: AAA, classKeys: new Set([COURSE]) }),
        family({ familyId: BBB }),
        family({ familyId: CCC, classKeys: new Set([COURSE]) }),
      ]),
    ).toEqual([expect.objectContaining({ familyAId: AAA, familyBId: CCC, signal: 'same_class' })]);
  });

  /** Catches a walk that keeps looking after it has found a shared key (DDD would win),
   * and a fallback that is not the first eligible partner in id order. */
  it('takes the FIRST shared-key partner in id order, and first-fits everyone left over', () => {
    expect(
      pairs([
        family({ familyId: AAA, classKeys: new Set([COURSE]) }),
        family({ familyId: BBB }),
        family({ familyId: CCC, classKeys: new Set([COURSE]) }),
        family({ familyId: DDD, classKeys: new Set([COURSE]) }),
      ]),
    ).toEqual([
      expect.objectContaining({ familyAId: AAA, familyBId: CCC, signal: 'same_class' }),
      expect.objectContaining({ familyAId: BBB, familyBId: DDD, signal: 'same_area' }),
    ]);
  });

  /** Catches a rank hoisted out of the per-area bucket — the one mutation that would turn
   * "a Hale family near you" into a family two hours away who happens to want the same
   * class. M4K and M5V are both Toronto and both FSA-exact by design. */
  it('never pairs across match areas on a shared class key', () => {
    expect(
      pairs([
        family({ familyId: AAA, fsa: 'M4K', classKeys: new Set([COURSE]) }),
        family({ familyId: BBB, fsa: 'M5V', classKeys: new Set([COURSE]) }),
      ]),
    ).toEqual([]);
  });

  /** Catches a rank that pairs on the key alone: the band is still required, and it is
   * still the earliest band SHARED with the chosen partner rather than the left family's
   * own earliest. */
  it('never lets a shared class key stand in for the stage band', () => {
    expect(
      pairs([
        family({
          familyId: AAA,
          classKeys: new Set([COURSE]),
          children: [{ id: 'tot', dateOfBirth: '2024-02-11' }],
        }),
        family({
          familyId: BBB,
          classKeys: new Set([COURSE]),
          children: [{ id: 'big', dateOfBirth: '2019-02-11' }],
        }),
      ]),
    ).toEqual([]);

    expect(
      pairs([
        family({
          familyId: AAA,
          classKeys: new Set([COURSE]),
          children: [
            { id: 'a-tot', dateOfBirth: '2024-02-11' },
            { id: 'a-big', dateOfBirth: '2019-02-11' },
          ],
        }),
        family({
          familyId: BBB,
          classKeys: new Set([COURSE]),
          children: [{ id: 'b-big', dateOfBirth: '2019-02-11' }],
        }),
      ]),
    ).toEqual([
      expect.objectContaining({ stage: 'child', familyAChildId: 'a-big', signal: 'same_class' }),
    ]);
  });

  /** Catches a rank that treats a shared class as a reason to ask a burned pair again.
   * Closed is forever; a shared class is not a one-time exception to it. */
  it('never re-proposes a pair in pairedBefore, however good the signal', () => {
    expect(
      pairs(
        [
          family({ familyId: AAA, classKeys: new Set([COURSE]) }),
          family({ familyId: BBB }),
          family({ familyId: CCC, classKeys: new Set([COURSE]) }),
        ],
        new Set([`${AAA}:${CCC}`]),
      ),
    ).toEqual([expect.objectContaining({ familyAId: AAA, familyBId: BBB, signal: 'same_area' })]);
  });

  /** Two families holding keys that do not INTERSECT are not a same-class pair. Catches an
   * intersection written as "both sides hold at least one key". */
  it('ranks on the shared key, not on holding a key', () => {
    expect(
      pairs([
        family({ familyId: AAA, classKeys: new Set([COURSE]) }),
        family({ familyId: BBB, classKeys: new Set([OTHER_COURSE]) }),
      ]),
    ).toEqual([expect.objectContaining({ familyAId: AAA, familyBId: BBB, signal: 'same_area' })]);
  });

  /** With no keys anywhere the matcher is today's matcher. Catches a fallback that is not
   * first-in-id-order (which would pair AAA with CCC) and a default signal that is not
   * 'same_area'. */
  it('is byte-for-byte today’s first-fit pairing when no family holds a key', () => {
    expect(
      pairs([family({ familyId: AAA }), family({ familyId: BBB }), family({ familyId: CCC })]),
    ).toEqual([
      {
        familyAId: AAA,
        familyBId: BBB,
        familyAChildId: `child-${AAA}`,
        familyBChildId: `child-${BBB}`,
        fsa: 'M4K',
        stage: 'toddler',
        signal: 'same_area',
      },
    ]);
  });
});
