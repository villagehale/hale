import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  AGE_TOLERANCE_MONTHS,
  matchRegistrationWindows,
  type RegistrationMatch,
  resolveMunicipalities,
} from './match-registration-windows.js';

/**
 * The registration radar's matcher. Expectations here are derived from the M1 spec,
 * not from the implementation's output:
 *   - a window is relevant when the family's FSA resolves to its municipality AND at
 *     least one child falls in its age band (inclusive at both edges);
 *   - a child outside the band but within ±6 months still matches, flagged approximate,
 *     because a DOB derived from "she's about 3" is not precise;
 *   - a resident head start is only claimed when the FSA resolves to exactly ONE
 *     municipality — an ambiguous FSA falls back to the general open date, because
 *     promising a parent an earlier date they can't use is the worse failure;
 *   - windows the family can no longer act on are excluded.
 */

/** Build a window row; only the fields a test cares about need overriding. */
function win(overrides: Partial<RegistrationWindow> = {}): RegistrationWindow {
  return {
    id: 'w-1',
    municipality: 'markham' as Municipality,
    programDomain: 'rec_program' as ProgramDomain,
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: new Date('2026-09-01T10:30:00.000Z'),
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: 'https://www.markham.ca/example',
    verifiedAt: new Date('2026-07-30T00:00:00.000Z'),
    notes: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    ...overrides,
  };
}

/** The single match a test expects — asserts the count rather than assuming it. */
function onlyMatch(matches: RegistrationMatch[]): RegistrationMatch {
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (!match) throw new Error('expected exactly one match');
  return match;
}

const BEFORE_EVERYTHING = new Date('2026-08-01T00:00:00.000Z');

describe('resolveMunicipalities', () => {
  it('resolves an unambiguous Markham FSA to exactly one municipality', () => {
    expect(resolveMunicipalities('L3R 0B4')).toEqual(['markham']);
  });

  it('treats every M-prefixed FSA as Toronto (Canada Post assigns M to Toronto alone)', () => {
    expect(resolveMunicipalities('M5V 3L9')).toEqual(['toronto']);
    expect(resolveMunicipalities('M1B')).toEqual(['toronto']);
  });

  it('normalises case and spacing before reading the FSA', () => {
    expect(resolveMunicipalities('l3r0b4')).toEqual(['markham']);
    expect(resolveMunicipalities('  L3R 0B4  ')).toEqual(['markham']);
  });

  it('returns nothing for a postal code outside the covered municipalities', () => {
    // K1A is Ottawa — outside the GTA coverage set entirely.
    expect(resolveMunicipalities('K1A 0B1')).toEqual([]);
  });

  it('returns nothing for a malformed postal code rather than guessing', () => {
    expect(resolveMunicipalities('')).toEqual([]);
    expect(resolveMunicipalities('12')).toEqual([]);
  });
});

describe('matchRegistrationWindows — age bands', () => {
  it('includes a child exactly at the minimum edge as an exact match', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: 72 })];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [48],
      now: BEFORE_EVERYTHING,
    });
    const match = onlyMatch(out);
    expect(match.ageApproximate).toBe(false);
    expect(match.matchedChildAgesMonths).toEqual([48]);
  });

  it('includes a child exactly at the maximum edge as an exact match', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: 72 })];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [72],
      now: BEFORE_EVERYTHING,
    });
    expect(onlyMatch(out).ageApproximate).toBe(false);
  });

  it('flags a child just outside the band but inside the ±6-month tolerance', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: 72 })];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [73],
      now: BEFORE_EVERYTHING,
    });
    const match = onlyMatch(out);
    expect(match.ageApproximate).toBe(true);
    expect(match.matchedChildAgesMonths).toEqual([73]);
  });

  it('admits a child exactly at the far edge of the tolerance', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: 72 })];
    const atMin = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [48 - AGE_TOLERANCE_MONTHS],
      now: BEFORE_EVERYTHING,
    });
    expect(onlyMatch(atMin).ageApproximate).toBe(true);
  });

  it('excludes a child beyond the tolerance entirely', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: 72 })];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [72 + AGE_TOLERANCE_MONTHS + 1],
      now: BEFORE_EVERYTHING,
    });
    expect(out).toEqual([]);
  });

  it('prefers the exact match when one child is exact and a sibling is only approximate', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: 72 })];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [73, 60],
      now: BEFORE_EVERYTHING,
    });
    // Both children are surfaced, but the window is not flagged approximate because
    // at least one child is genuinely in band.
    const match = onlyMatch(out);
    expect(match.matchedChildAgesMonths).toEqual([73, 60]);
    expect(match.ageApproximate).toBe(false);
  });

  it('treats a null bound as unbounded on that side', () => {
    const windows = [win({ ageMinMonths: 48, ageMaxMonths: null })];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [216],
      now: BEFORE_EVERYTHING,
    });
    expect(onlyMatch(out).ageApproximate).toBe(false);
  });

  it('matches an all-ages window (both bounds null) for any child', () => {
    const out = matchRegistrationWindows({
      windows: [win()],
      postal: 'L3R 0B4',
      childrenAgesMonths: [2],
      now: BEFORE_EVERYTHING,
    });
    expect(out).toHaveLength(1);
  });

  it('returns nothing when the family has no children to match against', () => {
    const out = matchRegistrationWindows({
      windows: [win()],
      postal: 'L3R 0B4',
      childrenAgesMonths: [],
      now: BEFORE_EVERYTHING,
    });
    expect(out).toEqual([]);
  });
});

describe('matchRegistrationWindows — municipality resolution', () => {
  it('drops windows for municipalities the family does not live in', () => {
    const windows = [
      win({ id: 'mk', municipality: 'markham' }),
      win({ id: 'ov', municipality: 'oakville' }),
    ];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });
    expect(out.map((m) => m.window.id)).toEqual(['mk']);
  });

  it('returns nothing when the postal code is outside the covered municipalities', () => {
    const out = matchRegistrationWindows({
      windows: [win()],
      postal: 'K1A 0B1',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });
    expect(out).toEqual([]);
  });
});

describe('matchRegistrationWindows — resident priority', () => {
  const residentWindow = win({
    municipality: 'oakville',
    residentOpenAt: new Date('2026-09-01T13:00:00.000Z'),
    openAt: new Date('2026-09-15T13:00:00.000Z'),
    residentPriorityDays: 14,
  });

  it('gives a resident the earlier resident open date and still surfaces the general one', () => {
    // L6H is Oakville-only, so residency is confirmed.
    const out = matchRegistrationWindows({
      windows: [residentWindow],
      postal: 'L6H 1A1',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });
    const match = onlyMatch(out);
    expect(match.isResidentWindow).toBe(true);
    expect(match.opensForFamilyAt).toEqual(new Date('2026-09-01T13:00:00.000Z'));
    expect(match.generalOpenAt).toEqual(new Date('2026-09-15T13:00:00.000Z'));
  });

  it('falls back to the general open date when the window has no resident head start', () => {
    const out = matchRegistrationWindows({
      windows: [win({ municipality: 'oakville', residentOpenAt: null })],
      postal: 'L6H 1A1',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });
    const match = onlyMatch(out);
    expect(match.isResidentWindow).toBe(true);
    expect(match.opensForFamilyAt).toEqual(match.generalOpenAt);
  });

  it('does NOT claim residency when the FSA spans two municipalities', () => {
    // L4J (Thornhill) straddles the Vaughan/Markham boundary, so we cannot confirm
    // which town this family pays taxes to — the safe answer is the general date.
    const spanning = resolveMunicipalities('L4J 1A1');
    expect(spanning.length).toBeGreaterThan(1);

    const windows = spanning.map((municipality, i) =>
      win({
        id: `w-${i}`,
        municipality,
        residentOpenAt: new Date('2026-09-01T13:00:00.000Z'),
        openAt: new Date('2026-09-08T13:00:00.000Z'),
        residentPriorityDays: 7,
      }),
    );
    const out = matchRegistrationWindows({
      windows,
      postal: 'L4J 1A1',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });

    // Both towns' windows surface (the family is in one of them), but neither claims
    // the resident head start.
    expect(out).toHaveLength(spanning.length);
    for (const match of out) {
      expect(match.isResidentWindow).toBe(false);
      expect(match.opensForFamilyAt).toEqual(new Date('2026-09-08T13:00:00.000Z'));
    }
  });
});

describe('matchRegistrationWindows — time', () => {
  it('excludes a window the family can no longer act on', () => {
    const out = matchRegistrationWindows({
      windows: [win({ openAt: new Date('2026-08-11T10:30:00.000Z') })],
      postal: 'L3R 0B4',
      childrenAgesMonths: [60],
      now: new Date('2026-08-11T10:30:00.001Z'),
    });
    expect(out).toEqual([]);
  });

  it('keeps a window that opens one second from now', () => {
    const out = matchRegistrationWindows({
      windows: [win({ openAt: new Date('2026-08-11T10:30:00.000Z') })],
      postal: 'L3R 0B4',
      childrenAgesMonths: [60],
      now: new Date('2026-08-11T10:29:59.000Z'),
    });
    expect(out).toHaveLength(1);
  });

  it('excludes a resident window whose resident date has passed even though the general date has not', () => {
    const out = matchRegistrationWindows({
      windows: [
        win({
          municipality: 'oakville',
          residentOpenAt: new Date('2026-09-01T13:00:00.000Z'),
          openAt: new Date('2026-09-15T13:00:00.000Z'),
        }),
      ],
      postal: 'L6H 1A1',
      childrenAgesMonths: [60],
      now: new Date('2026-09-02T00:00:00.000Z'),
    });
    // The resident can already register; the radar's warning has done its job.
    expect(out).toEqual([]);
  });

  it('is DST-correct: a 6:30 a.m. Toronto open the day after the fall-back is 11:30 UTC', () => {
    // DST ends Sun 1 Nov 2026, so Mon 2 Nov is EST (UTC-5): 06:30 local = 11:30 UTC.
    // Had the seed used the summer offset (-04:00) this window would read as 10:30 UTC
    // and this "still upcoming at 11:00 UTC" assertion would fail.
    const openAt = new Date('2026-11-02T06:30:00-05:00');
    const out = matchRegistrationWindows({
      windows: [win({ openAt })],
      postal: 'L3R 0B4',
      childrenAgesMonths: [60],
      now: new Date('2026-11-02T11:00:00.000Z'),
    });
    expect(openAt.toISOString()).toBe('2026-11-02T11:30:00.000Z');
    expect(out).toHaveLength(1);
  });

  it('sorts matches by when THIS family can register, earliest first', () => {
    const windows = [
      win({ id: 'late', cycleLabel: 'Winter 2027', openAt: new Date('2026-11-10T11:30:00.000Z') }),
      win({ id: 'early', cycleLabel: 'Fall 2026', openAt: new Date('2026-08-11T10:30:00.000Z') }),
      win({ id: 'mid', cycleLabel: 'Camps 2026', openAt: new Date('2026-09-15T10:30:00.000Z') }),
    ];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L3R 0B4',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });
    expect(out.map((m) => m.window.id)).toEqual(['early', 'mid', 'late']);
  });

  it('orders a resident head start ahead of an earlier general date in another town', () => {
    // A Thornhill-ambiguous family is not used here; L6H is Oakville-only so the
    // resident date is real and must sort by the date the family can actually act on.
    const windows = [
      win({
        id: 'general-first',
        municipality: 'oakville',
        cycleLabel: 'Winter 2027',
        openAt: new Date('2026-09-10T13:00:00.000Z'),
      }),
      win({
        id: 'resident-earlier',
        municipality: 'oakville',
        cycleLabel: 'Fall 2026',
        residentOpenAt: new Date('2026-09-01T13:00:00.000Z'),
        openAt: new Date('2026-09-15T13:00:00.000Z'),
      }),
    ];
    const out = matchRegistrationWindows({
      windows,
      postal: 'L6H 1A1',
      childrenAgesMonths: [60],
      now: BEFORE_EVERYTHING,
    });
    expect(out.map((m) => m.window.id)).toEqual(['resident-earlier', 'general-first']);
  });
});

/**
 * VIL-260 · WS3 — Burlington publishes ONE registration event in three table rows.
 *
 * "Fall and winter youth", "Fall swimming lessons" and "Fall and winter Aquatic
 * Leadership programs" share an instant, a page and (an absent) age band; the Town
 * opens them together. Proposed as three matches, the sort's alphabetical tie-break
 * decided which one a family heard about — and "Aquatic Leadership" sorts first, so a
 * Burlington family with a 30-month-old was proposed the teen lifeguard-certification
 * cycle. They collapse into one match carrying every cycle.
 */
describe('matchRegistrationWindows — cycles that open together are ONE event', () => {
  const BURLINGTON = {
    municipality: 'burlington' as Municipality,
    residentOpenAt: new Date('2026-08-22T13:00:00.000Z'),
    openAt: new Date('2026-08-28T13:00:00.000Z'),
    sourceUrl: 'https://www.burlington.ca/registering',
  };

  function burlingtonTriple(): RegistrationWindow[] {
    return [
      win({
        ...BURLINGTON,
        id: 'youth',
        programDomain: 'rec_program' as ProgramDomain,
        cycleLabel: 'Fall 2026 and Winter 2027 youth programs',
      }),
      win({
        ...BURLINGTON,
        id: 'swim',
        programDomain: 'swim' as ProgramDomain,
        cycleLabel: 'Fall 2026 swimming lessons',
      }),
      win({
        ...BURLINGTON,
        id: 'leadership',
        programDomain: 'swim' as ProgramDomain,
        cycleLabel: 'Fall 2026 and Winter 2027 Aquatic Leadership programs',
      }),
    ];
  }

  it('collapses same-municipality, same-instant, same-page cycles into one match', () => {
    const out = matchRegistrationWindows({
      windows: burlingtonTriple(),
      postal: 'L7R 1A1',
      childrenAgesMonths: [30],
      now: BEFORE_EVERYTHING,
    });

    const match = onlyMatch(out);
    // Every cycle the Town opens at that instant is carried, so the copy can name
    // what actually opens instead of picking one alphabetically.
    expect([...match.cycleWindows].map((w) => w.id).sort()).toEqual([
      'leadership',
      'swim',
      'youth',
    ]);
  });

  it('keeps cycles that open at DIFFERENT instants separate', () => {
    const [youth, swim] = burlingtonTriple();
    if (!youth || !swim) throw new Error('fixture');
    const out = matchRegistrationWindows({
      // A Burlington-only FSA registers on the RESIDENT date, so that is the instant
      // that has to differ for the two to be separate registration mornings.
      windows: [youth, { ...swim, residentOpenAt: new Date('2026-09-04T13:00:00.000Z') }],
      postal: 'L7R 1A1',
      childrenAgesMonths: [30],
      now: BEFORE_EVERYTHING,
    });
    expect(out).toHaveLength(2);
  });

  it('keeps cycles with DIFFERENT published age bands separate — the fit note depends on the band', () => {
    const [youth, swim] = burlingtonTriple();
    if (!youth || !swim) throw new Error('fixture');
    const out = matchRegistrationWindows({
      windows: [youth, { ...swim, ageMinMonths: 24, ageMaxMonths: 60 }],
      postal: 'L7R 1A1',
      childrenAgesMonths: [30],
      now: BEFORE_EVERYTHING,
    });
    expect(out).toHaveLength(2);
  });

  it('carries a lone window as a one-cycle event', () => {
    const out = matchRegistrationWindows({
      windows: [win()],
      postal: 'L3R 0B4',
      childrenAgesMonths: [30],
      now: BEFORE_EVERYTHING,
    });
    expect(onlyMatch(out).cycleWindows).toHaveLength(1);
  });
});
