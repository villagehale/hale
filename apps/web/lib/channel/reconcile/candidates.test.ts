import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAIM_ROW_ALIASES,
  CLAIM_ROW_MAX_HOST_CHARS,
  CLAIM_ROW_MAX_WHAT_CHARS,
  type ClaimCandidateRow,
  ForeignCandidateRow,
  buildClaimCandidates,
} from './candidates';
import { claimRowLabel } from './claim-label';

/**
 * VIL-581 · the citation namespace. The alias enum is static (one grammar for every
 * call); the per-call map is built only from this family's rows, and the projection is
 * all the model ever sees of them.
 */

const FAM = 'fam-a';
const TZ = 'America/Denver';
const AT = new Date('2026-11-07T15:00:00Z');
const NOW = new Date('2026-11-03T12:00:00Z');

/** Test labels go through the one constructor, as an adult non-sensitive row would. */
const label = (text: string) => claimRowLabel({ from: 'pending', text }, NOW);

const cal = (what: string, startsAt = AT): ClaimCandidateRow => ({
  familyId: FAM,
  source: 'calendar',
  kind: 'scheduled_event',
  what: label(what),
  startsAt,
});
const ROWS: ClaimCandidateRow[] = [
  cal('Swim lesson'),
  cal('Dentist visit'),
  {
    familyId: FAM,
    source: 'parent_stated',
    kind: 'scheduled_event',
    what: label('18-month checkup'),
  },
  {
    familyId: FAM,
    source: 'open_commitment',
    kind: 'activity_followup',
    what: label('Swim classes'),
  },
  {
    familyId: FAM,
    source: 'watched_page',
    kind: 'spot_watch',
    what: label('Saturday swim, ages 3-5'),
    host: 'register.example.org',
  },
  {
    familyId: FAM,
    source: 'live_sequence',
    kind: 'registration_watch',
    what: label('Maple Bend aquatics winter registration'),
    opensAt: new Date('2026-12-01T14:00:00Z'),
  },
  {
    familyId: FAM,
    source: 'mintable_window',
    kind: 'registration_watch',
    what: label('Riverford recreation winter registration'),
    opensForFamilyAt: new Date('2026-12-03T15:00:00Z'),
  },
  {
    familyId: FAM,
    source: 'pending',
    kind: 'activity_followup',
    what: label('Toddler activities'),
  },
  { familyId: FAM, source: 'pending', kind: 'spot_watch', what: label('Swim class page') },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildClaimCandidates', () => {
  it('assigns per-slot aliases in input order', () => {
    const set = buildClaimCandidates(FAM, ROWS, TZ);
    expect(set.projected.map((r) => r.a)).toEqual([
      'e1',
      'e2',
      's1',
      'c1',
      'g1',
      'q1',
      'w1',
      'p1',
      'p2',
    ]);
    expect(set.byAlias.get('e2')).toBe(ROWS[1]);
    expect(set.byAlias.get('p2')).toBe(ROWS[8]);
    expect(set.familyId).toBe(FAM);
  });

  it('the alias enum has exactly 94 entries, and a full set only ever emits enum values', () => {
    expect(CLAIM_ROW_ALIASES).toHaveLength(1 + 50 + 20 + 5 + 10 + 5 + 1 + 2);
    expect(CLAIM_ROW_ALIASES[0]).toBe('none');
    const many = (n: number, row: ClaimCandidateRow) => Array.from({ length: n }, () => row);
    const full = buildClaimCandidates(
      FAM,
      [
        ...many(50, ROWS[0] as ClaimCandidateRow),
        ...many(20, ROWS[2] as ClaimCandidateRow),
        ...many(5, ROWS[3] as ClaimCandidateRow),
        ...many(10, ROWS[4] as ClaimCandidateRow),
        ...many(5, ROWS[5] as ClaimCandidateRow),
        ROWS[6] as ClaimCandidateRow,
        ROWS[7] as ClaimCandidateRow,
        ROWS[8] as ClaimCandidateRow,
      ],
      TZ,
    );
    expect(full.projected).toHaveLength(93);
    expect(full.capped).toEqual([]);
    const aliases = new Set<string>(CLAIM_ROW_ALIASES);
    for (const row of full.projected) expect(aliases.has(row.a), row.a).toBe(true);
    expect(new Set(full.projected.map((r) => r.a)).size).toBe(93);
  });

  it('drops rows past a slot cap, names them in capped, and logs once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = buildClaimCandidates(
      FAM,
      Array.from({ length: 51 }, (_, i) => cal(`Event ${i}`)),
      TZ,
    );
    expect(set.projected).toHaveLength(50);
    expect(set.capped).toEqual([{ slot: 'e', dropped: 1 }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      event: 'claim_read_candidates_capped',
      slot: 'e',
      dropped: 1,
    });
  });

  it('50 rows fit: nothing capped, nothing logged (control)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = buildClaimCandidates(
      FAM,
      Array.from({ length: 50 }, (_, i) => cal(`Event ${i}`)),
      TZ,
    );
    expect(set.capped).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws on another family's row", () => {
    const foreign: ClaimCandidateRow = { ...cal('Swim lesson'), familyId: 'fam-b' };
    expect(() => buildClaimCandidates(FAM, [cal('Swim lesson'), foreign], TZ)).toThrow(
      ForeignCandidateRow,
    );
    expect(() => buildClaimCandidates(FAM, [cal('Swim lesson')], TZ)).not.toThrow();
  });
});

describe('the projection', () => {
  it('carries exactly the fields the model needs, and no id, instant or link', () => {
    const set = buildClaimCandidates(FAM, ROWS, TZ);
    const keys = (alias: string) =>
      Object.keys(set.projected.find((r) => r.a === alias) ?? {}).sort();
    expect(keys('e1')).toEqual(['a', 'kind', 'state', 'what', 'when']);
    expect(keys('s1')).toEqual(['a', 'kind', 'source', 'state', 'what']);
    expect(keys('g1')).toEqual(['a', 'host', 'kind', 'state', 'what']);
    const wire = JSON.stringify(set.projected);
    expect(wire).not.toContain(FAM);
    expect(wire).not.toContain('familyId');
    expect(wire).not.toContain('startsAt');
    expect(wire).not.toContain('2026-11-07T');
    expect(wire).not.toContain('https://');
    // Positive control: the labels themselves are there.
    for (const what of ['Swim lesson', '18-month checkup', 'Saturday swim, ages 3-5']) {
      expect(wire).toContain(what);
    }
  });

  it('formats `when` in the family zone it is given', () => {
    const mountain = buildClaimCandidates(FAM, [cal('Swim lesson')], 'America/Denver');
    const eastern = buildClaimCandidates(FAM, [cal('Swim lesson')], 'America/New_York');
    expect(mountain.projected[0]?.when).toContain('Sat');
    expect(mountain.projected[0]?.when).toContain('8:00');
    expect(eastern.projected[0]?.when).toContain('10:00');
  });

  it('names each state', () => {
    const set = buildClaimCandidates(FAM, ROWS, TZ);
    expect(Object.fromEntries(set.projected.map((r) => [r.a, r.state]))).toEqual({
      e1: 'open',
      e2: 'open',
      s1: 'open',
      c1: 'open',
      g1: 'open',
      q1: 'live',
      w1: 'mintable',
      p1: 'pending',
      p2: 'pending',
    });
  });
});

describe('the brand', () => {
  it('a raw string is not a label', () => {
    const row: ClaimCandidateRow = {
      familyId: FAM,
      source: 'parent_stated',
      kind: 'scheduled_event',
      // @ts-expect-error a raw string is not a ClaimRowLabel
      what: 'Swim lesson',
    };
    expect(row.what).toBe('Swim lesson');
  });
});

describe('the projection is bounded', () => {
  const lonePiece = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const page = (what: string, host: string): ClaimCandidateRow => ({
    familyId: FAM,
    source: 'watched_page',
    kind: 'spot_watch',
    what: label(what),
    host,
  });

  it('the bounds are 160 code points of label and 253 of host (the DNS name limit)', () => {
    expect(CLAIM_ROW_MAX_WHAT_CHARS).toBe(160);
    expect(CLAIM_ROW_MAX_HOST_CHARS).toBe(253);
  });

  it('a 161-code-point label is cut to 160; a 300-char host to 253', () => {
    const set = buildClaimCandidates(FAM, [page('é'.repeat(161), 'h'.repeat(300))], TZ);
    expect([...(set.projected[0]?.what ?? '')]).toHaveLength(160);
    expect(set.projected[0]?.host).toHaveLength(253);
  });

  it('a label at the bound is unchanged (control)', () => {
    const exact = 'é'.repeat(160);
    const set = buildClaimCandidates(FAM, [page(exact, 'register.example.org')], TZ);
    expect(set.projected[0]?.what).toBe(exact);
    expect(set.projected[0]?.host).toBe('register.example.org');
  });

  it('an emoji label cut at the bound leaves no lone surrogate', () => {
    const set = buildClaimCandidates(FAM, [cal('🏊'.repeat(200))], TZ);
    const what = set.projected[0]?.what ?? '';
    expect([...what]).toHaveLength(160);
    expect(lonePiece.test(what)).toBe(false);
    // Positive control: a naive UTF-16 cut does leave one.
    expect(lonePiece.test('🏊'.repeat(200).slice(0, 159))).toBe(true);
  });
});
