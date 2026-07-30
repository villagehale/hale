import { describe, expect, it } from 'vitest';
import {
  HEALTH_CHECKPOINTS,
  checkpointOccurrence,
  checkpointRef,
  schoolYearOf,
} from './checkpoints';
import { type HealthChild, matchHealthCheckpoints } from './match';

/**
 * VIL-243 · M8 — MATCHING. The whole feature rests on "is this family inside this
 * administrative window right now", so the band edges, the derived-DOB tolerance and
 * the done-suppression are tested at their exact boundaries rather than in the middle.
 */

const TORONTO = 'M4C';
const YORK = 'L4C';

function child(overrides: Partial<HealthChild> = {}): HealthChild {
  return {
    id: 'child-1',
    name: 'Maya',
    ageMonths: 6,
    dobPrecision: 'exact',
    isTeen: false,
    ...overrides,
  };
}

/** Inside the 2026-27 school year: September has passed, so schoolYearOf() is 2026. */
const IN_SCHOOL_YEAR_2026 = new Date('2026-11-15T12:00:00');

function match(input: {
  children: HealthChild[];
  areaCoarse?: string | null;
  doneRefs?: Set<string>;
  now?: Date;
}) {
  return matchHealthCheckpoints({
    children: input.children,
    areaCoarse: input.areaCoarse === undefined ? YORK : input.areaCoarse,
    doneRefs: input.doneRefs ?? new Set<string>(),
    now: input.now ?? IN_SCHOOL_YEAR_2026,
  });
}

function ids(input: Parameters<typeof match>[0]): string[] {
  return match(input).map((m) => m.checkpoint.id);
}

const SIX_MONTH = 'immunization_6_months';

describe('band boundaries', () => {
  it('admits a child exactly on the first and last month of an exact-DOB band', () => {
    const band = HEALTH_CHECKPOINTS.find((c) => c.id === SIX_MONTH);
    if (!band) throw new Error('fixture drift: the 6-month checkpoint is gone');

    expect(ids({ children: [child({ ageMonths: band.minMonths })] })).toContain(SIX_MONTH);
    expect(ids({ children: [child({ ageMonths: band.maxMonths })] })).toContain(SIX_MONTH);
  });

  it('excludes an exact-DOB child one month outside either edge', () => {
    const band = HEALTH_CHECKPOINTS.find((c) => c.id === SIX_MONTH);
    if (!band) throw new Error('fixture drift: the 6-month checkpoint is gone');

    expect(ids({ children: [child({ ageMonths: band.minMonths - 1 })] })).not.toContain(SIX_MONTH);
    expect(ids({ children: [child({ ageMonths: band.maxMonths + 1 })] })).not.toContain(SIX_MONTH);
  });
});

describe('the derived-DOB tolerance', () => {
  it('opens a band EARLY for a child whose age the parent gave in words', () => {
    const band = HEALTH_CHECKPOINTS.find((c) => c.id === SIX_MONTH);
    if (!band) throw new Error('fixture drift: the 6-month checkpoint is gone');

    expect(
      ids({ children: [child({ ageMonths: band.minMonths - 1, dobPrecision: 'derived' })] }),
    ).toContain(SIX_MONTH);
  });

  it('never extends a band PAST its end, however imprecise the age', () => {
    // The asymmetry is the safety argument: arriving early is a window opening, and
    // arriving late is a message about a visit the child has aged out of — which is the
    // one thing this feature must never say.
    const band = HEALTH_CHECKPOINTS.find((c) => c.id === SIX_MONTH);
    if (!band) throw new Error('fixture drift: the 6-month checkpoint is gone');

    expect(
      ids({ children: [child({ ageMonths: band.maxMonths + 1, dobPrecision: 'derived' })] }),
    ).not.toContain(SIX_MONTH);
  });

  it('never lets the slack exceed the width of the window itself', () => {
    // The 2-month checkpoint is a two-month window. A ±6-month slack there would admit
    // a newborn and an eight-month-old to the same visit, which is not a match, it is a
    // shrug. The slack is clamped to the band width.
    const band = HEALTH_CHECKPOINTS.find((c) => c.id === 'immunization_2_months');
    if (!band) throw new Error('fixture drift: the 2-month checkpoint is gone');
    const width = band.maxMonths - band.minMonths;

    expect(
      ids({ children: [child({ ageMonths: band.minMonths - width, dobPrecision: 'derived' })] }),
    ).toContain('immunization_2_months');
    expect(
      ids({
        children: [child({ ageMonths: band.minMonths - width - 1, dobPrecision: 'derived' })],
      }),
    ).not.toContain('immunization_2_months');
  });
});

describe('region gating', () => {
  it('offers a Toronto-only checkpoint to a Toronto FSA', () => {
    const toronto = match({ children: [child({ ageMonths: 96 })], areaCoarse: TORONTO });
    expect(toronto.some((m) => m.checkpoint.region === 'toronto')).toBe(true);
  });

  it('never offers a Toronto-only checkpoint outside Toronto', () => {
    const york = match({ children: [child({ ageMonths: 96 })], areaCoarse: YORK });
    expect(york.some((m) => m.checkpoint.region === 'toronto')).toBe(false);
  });

  it('says nothing at all when the family has no area, or a non-Ontario one', () => {
    expect(match({ children: [child()], areaCoarse: null })).toEqual([]);
    expect(match({ children: [child()], areaCoarse: 'V6B' })).toEqual([]);
  });
});

describe('ordering and the single candidate', () => {
  it('puts the window that closes soonest first', () => {
    const ordered = match({
      children: [
        child({ id: 'a', name: 'Maya', ageMonths: 6 }),
        child({ id: 'b', name: 'Noah', ageMonths: 96 }),
      ],
      areaCoarse: TORONTO,
    });
    // Maya's 6-month window closes in months; the annual Toronto records check runs for
    // years. The tight one wins.
    expect(ordered[0]?.checkpoint.id).toBe(SIX_MONTH);
    expect(ordered[0]?.primaryChildId).toBe('a');
  });

  it('names every under-13 sibling a single checkpoint applies to', () => {
    const [first] = match({
      children: [
        child({ id: 'a', name: 'Maya', ageMonths: 100 }),
        child({ id: 'b', name: 'Noah', ageMonths: 110 }),
      ],
      areaCoarse: TORONTO,
    });
    expect(first?.checkpoint.id).toBe('school_records_ispa');
    expect(first?.kidNames).toEqual(['Maya', 'Noah']);
  });

  it('drops a child with no name from the roll call without dropping the match', () => {
    const [first] = match({
      children: [child({ id: 'a', name: null, ageMonths: 6 })],
    });
    expect(first?.checkpoint.id).toBe(SIX_MONTH);
    expect(first?.kidNames).toEqual([]);
  });
});

describe('teen handling (rule #1)', () => {
  it('marks a match whose only children are 13+ as teen-only and names nobody', () => {
    const [first] = match({
      children: [child({ id: 't', name: null, ageMonths: 174, isTeen: true })],
      areaCoarse: TORONTO,
    });
    expect(first?.teenOnly).toBe(true);
    expect(first?.kidNames).toEqual([]);
    expect(first?.teenCount).toBe(1);
  });

  it('never emits a teen match for a checkpoint with no teen-safe wording', () => {
    // Fail-closed, proved against the GUARD rather than against today's table: a teen is
    // forced to each specific-only band's own edges, and must still be dropped. A future
    // row that stretched into teen ages cannot quietly start leaking specifics.
    for (const checkpoint of HEALTH_CHECKPOINTS) {
      if (checkpoint.teenSafeTask !== null) continue;
      for (const ageMonths of [checkpoint.minMonths, checkpoint.maxMonths]) {
        const matched = match({
          children: [child({ id: 't', name: null, ageMonths, isTeen: true })],
          areaCoarse: TORONTO,
        }).map((m) => m.checkpoint.id);
        expect({ id: checkpoint.id, ageMonths, emitted: matched.includes(checkpoint.id) }).toEqual(
          { id: checkpoint.id, ageMonths, emitted: false },
        );
      }
    }
  });

  it('keeps a mixed sibling match on the under-13 names only', () => {
    const toronto = match({
      children: [
        child({ id: 'kid', name: 'Maya', ageMonths: 96 }),
        child({ id: 'teen', name: null, ageMonths: 168, isTeen: true }),
      ],
      areaCoarse: TORONTO,
    });
    const records = toronto.find((m) => m.checkpoint.region === 'toronto');
    expect(records?.teenOnly).toBe(false);
    expect(records?.kidNames).toEqual(['Maya']);
  });
});

describe('done suppression', () => {
  it('drops a checkpoint the parent has already marked done', () => {
    const [first] = match({ children: [child()] });
    if (!first) throw new Error('expected a match to suppress');

    expect(ids({ children: [child()], doneRefs: new Set([first.ref]) })).not.toContain(
      first.checkpoint.id,
    );
  });

  it('suppresses a ONE-TIME checkpoint per child, so a sibling still hears about it', () => {
    const six = HEALTH_CHECKPOINTS.find((c) => c.id === SIX_MONTH);
    if (!six) throw new Error('fixture drift: the 6-month checkpoint is gone');
    const children = [
      child({ id: 'a', name: 'Maya', ageMonths: 6 }),
      child({ id: 'b', name: 'Noah', ageMonths: 6 }),
    ];
    const [first] = match({ children, doneRefs: new Set([checkpointRef(six, 'a', 0)]) });

    expect(first?.checkpoint.id).toBe(SIX_MONTH);
    expect(first?.primaryChildId).toBe('b');
    expect(first?.kidNames).toEqual(['Noah']);
  });

  it('suppresses an ANNUAL checkpoint for the whole household', () => {
    // One errand, done in one sitting, for every child the message named. Re-asking
    // about a sibling next week is exactly the nagging this feature removes.
    const annual = HEALTH_CHECKPOINTS.find((c) => c.annual);
    if (!annual) throw new Error('fixture drift: no annual checkpoint');
    const children = [
      child({ id: 'a', name: 'Maya', ageMonths: 100 }),
      child({ id: 'b', name: 'Noah', ageMonths: 110 }),
    ];
    const done = new Set([checkpointRef(annual, 'a', schoolYearOf(IN_SCHOOL_YEAR_2026))]);

    expect(ids({ children, areaCoarse: TORONTO })).toContain(annual.id);
    expect(ids({ children, areaCoarse: TORONTO, doneRefs: done })).not.toContain(annual.id);
  });
});

describe('occurrence', () => {
  it('is 0 for a one-time checkpoint, whatever the date', () => {
    const once = HEALTH_CHECKPOINTS.find((c) => !c.annual);
    if (!once) throw new Error('fixture drift: no one-time checkpoint');
    expect(checkpointOccurrence(once, new Date('2026-11-15T12:00:00'))).toBe(0);
    expect(checkpointOccurrence(once, new Date('2027-03-15T12:00:00'))).toBe(0);
  });

  it('names the SCHOOL year for an annual checkpoint, turning over in September', () => {
    const annual = HEALTH_CHECKPOINTS.find((c) => c.annual);
    if (!annual) throw new Error('fixture drift: no annual checkpoint');
    expect(checkpointOccurrence(annual, new Date('2026-08-31T12:00:00'))).toBe(2025);
    expect(checkpointOccurrence(annual, new Date('2026-09-01T12:00:00'))).toBe(2026);
    expect(checkpointOccurrence(annual, new Date('2027-06-30T12:00:00'))).toBe(2026);
  });

  it('re-opens an annual checkpoint the next school year, after a done', () => {
    const annual = HEALTH_CHECKPOINTS.find((c) => c.annual);
    if (!annual) throw new Error('fixture drift: no annual checkpoint');
    const kids = [child({ id: 'a', ageMonths: 100 })];
    const done = new Set([checkpointRef(annual, 'a', 2026)]);

    expect(
      ids({ children: kids, areaCoarse: TORONTO, doneRefs: done, now: IN_SCHOOL_YEAR_2026 }),
    ).not.toContain(annual.id);
    expect(
      ids({
        children: kids,
        areaCoarse: TORONTO,
        doneRefs: done,
        now: new Date('2027-11-15T12:00:00'),
      }),
    ).toContain(annual.id);
  });
});
