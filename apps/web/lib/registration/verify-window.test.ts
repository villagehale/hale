import { describe, expect, it } from 'vitest';
import {
  type ExtractedWindow,
  type StoredWindow,
  compareWindow,
  corroborationFailure,
  publishedInstant,
} from './verify-window';

/**
 * VIL-259 — the re-verify comparison, which is where "never silently change"
 * either holds or doesn't.
 *
 * The invariant every test here defends: NOTHING this module returns can be
 * applied to a stored row. `compareWindow` answers confirmed / discrepancy /
 * unverified, and only `confirmed` earns a write (and only to `verified_at`).
 * A discrepancy carries the two dates so a human can read them; it never
 * carries an instruction.
 *
 * Dates are the real GTA ones — Markham's 2026 fall cycle and Toronto's ARC
 * cycle, both read off the municipalities' own pages.
 */

/** Markham 2026 fall: preview Aug 3 (no time published), open Aug 11 06:30 EDT. */
function markhamStored(overrides: Partial<StoredWindow> = {}): StoredWindow {
  return {
    id: 'win-markham-fall',
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    previewAt: new Date('2026-08-03T00:00:00-04:00'),
    residentOpenAt: null,
    openAt: new Date('2026-08-11T06:30:00-04:00'),
    sourceUrl: 'https://www.markham.ca/registration',
    verifiedAt: new Date('2026-07-30T00:00:00-04:00'),
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedWindow> = {}): ExtractedWindow {
  return {
    found: true,
    reason: null,
    cycleOnPage: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    yearEvidence: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
    preview: { date: '2026-08-03', time: null },
    residentOpen: null,
    generalOpen: { date: '2026-08-11', time: '06:30' },
    evidence: 'Register starting Aug. 11 at 6:30 AM',
    confidence: 0.95,
    ...overrides,
  };
}

describe('publishedInstant', () => {
  it('reads a date+time as the America/Toronto wall clock, not the server zone', () => {
    // 06:30 EDT is 10:30Z. A server in UTC reading this naively would store 06:30Z
    // and warn four hours late.
    expect(publishedInstant({ date: '2026-08-11', time: '06:30' }).toISOString()).toBe(
      '2026-08-11T10:30:00.000Z',
    );
  });

  it('reads a date with NO published time as the start of that local day', () => {
    // The seed's own convention for date-only sources: start of day asserts no
    // time the town did not publish.
    expect(publishedInstant({ date: '2026-08-03', time: null }).toISOString()).toBe(
      '2026-08-03T04:00:00.000Z',
    );
  });

  it('applies the winter offset on an EST date', () => {
    // -05:00 in February. A hardcoded -04:00 would shift a 9 a.m. open by an hour.
    expect(publishedInstant({ date: '2027-02-10', time: '09:00' }).toISOString()).toBe(
      '2027-02-10T14:00:00.000Z',
    );
  });
});

describe('compareWindow — confirmed', () => {
  it('confirms when every date the page publishes matches the stored row', () => {
    const outcome = compareWindow(markhamStored(), extracted());
    expect(outcome).toEqual({ kind: 'confirmed', fields: ['previewAt', 'openAt'] });
  });

  it('confirms on the resident date alone when the page prints only that one', () => {
    // Toronto's shape: the page prints the RESIDENT date and states the
    // non-resident rule as prose, so open_at is rule-derived and the page can
    // never corroborate it. Comparing only what the page states is the honest
    // read — a field the page is silent about is not evidence of anything.
    const toronto = markhamStored({
      id: 'win-toronto-arc',
      municipality: 'toronto',
      programDomain: 'after_school_care',
      cycleLabel: 'After-School Recreation Care (ARC) 2026/2027 school year',
      previewAt: null,
      residentOpenAt: new Date('2026-06-05T07:00:00-04:00'),
      openAt: new Date('2026-06-15T07:00:00-04:00'),
    });
    const outcome = compareWindow(
      toronto,
      extracted({
        preview: null,
        residentOpen: { date: '2026-06-05', time: '07:00' },
        generalOpen: null,
      }),
    );
    expect(outcome).toEqual({ kind: 'confirmed', fields: ['residentOpenAt'] });
  });
});

describe('compareWindow — discrepancy NEVER becomes a change', () => {
  it('reports a moved date as a discrepancy carrying both instants', () => {
    const stored = markhamStored();
    const outcome = compareWindow(
      stored,
      extracted({
        generalOpen: { date: '2026-08-18', time: '06:30' },
        evidence: 'Register starting Aug. 18 at 6:30 AM',
      }),
    );

    expect(outcome.kind).toBe('discrepancy');
    if (outcome.kind !== 'discrepancy') throw new Error('expected a discrepancy');
    expect(outcome.diffs).toEqual([
      {
        field: 'openAt',
        stored: new Date('2026-08-11T06:30:00-04:00'),
        published: new Date('2026-08-18T06:30:00-04:00'),
      },
    ]);
    expect(outcome.evidence).toBe('Register starting Aug. 18 at 6:30 AM');
  });

  it('reports a moved TIME on the same day as a discrepancy', () => {
    // 6:30 a.m. → 7:00 a.m. is half an hour; for a cycle that sells out in four
    // minutes it is the whole thing.
    const outcome = compareWindow(
      markhamStored(),
      extracted({ generalOpen: { date: '2026-08-11', time: '07:00' } }),
    );
    expect(outcome.kind).toBe('discrepancy');
    if (outcome.kind !== 'discrepancy') throw new Error('expected a discrepancy');
    expect(outcome.diffs.map((d) => d.field)).toEqual(['openAt']);
  });

  it('reports a newly published field the stored row does not have', () => {
    // Markham publishes no resident tier today. If one appears, that is a real
    // change to tell a human about — not something to write in silently.
    const outcome = compareWindow(
      markhamStored(),
      extracted({ residentOpen: { date: '2026-08-04', time: '06:30' } }),
    );
    expect(outcome.kind).toBe('discrepancy');
    if (outcome.kind !== 'discrepancy') throw new Error('expected a discrepancy');
    expect(outcome.diffs).toEqual([
      {
        field: 'residentOpenAt',
        stored: null,
        published: new Date('2026-08-04T06:30:00-04:00'),
      },
    ]);
  });

  it('never returns a field the caller could apply — the outcome is diffs, not a patch', () => {
    const outcome = compareWindow(
      markhamStored(),
      extracted({ generalOpen: { date: '2026-08-18', time: '06:30' } }),
    );
    // Structural guard on rule "NEVER auto-change": there is no `apply`, no
    // `newRow`, no `openAt` on a discrepancy outcome — nothing a careless caller
    // could spread onto an update.
    expect(Object.keys(outcome).sort()).toEqual(['diffs', 'evidence', 'kind']);
  });
});

describe('compareWindow — a guess is never a verification', () => {
  it('is unverified, not confirmed, when the model is under the confidence floor', () => {
    const outcome = compareWindow(markhamStored(), extracted({ confidence: 0.4 }));
    expect(outcome).toEqual({ kind: 'unverified', reason: 'low_confidence' });
  });

  it('is unverified — NOT a discrepancy — when a low-confidence read disagrees', () => {
    // The trap: a shaky reading that happens to differ would otherwise page the
    // founder about a date the model was guessing at. Low confidence means we did
    // not verify; it never means we found a problem.
    const outcome = compareWindow(
      markhamStored(),
      extracted({ confidence: 0.3, generalOpen: { date: '2026-09-01', time: '06:30' } }),
    );
    expect(outcome).toEqual({ kind: 'unverified', reason: 'low_confidence' });
  });

  it.each([
    ['announced_later'],
    ['different_cycle_only'],
    ['no_year_stated'],
    ['not_published'],
  ] as const)('passes through the not-found reason %s', (reason) => {
    const outcome = compareWindow(
      markhamStored(),
      extracted({
        found: false,
        reason,
        preview: null,
        residentOpen: null,
        generalOpen: null,
        evidence: null,
        yearEvidence: null,
        cycleOnPage: null,
      }),
    );
    expect(outcome).toEqual({ kind: 'unverified', reason });
  });

  it('is unverified when the page states the cycle but no dates at all', () => {
    const outcome = compareWindow(
      markhamStored(),
      extracted({ preview: null, residentOpen: null, generalOpen: null }),
    );
    expect(outcome).toEqual({ kind: 'unverified', reason: 'no_dates_for_cycle' });
  });
});

describe('corroborationFailure — the anti-fabrication gate', () => {
  const PAGE =
    '2026 Fall Programs, Swim Lessons and Winter Break Camps. Preview starting Aug, 3. ' +
    'Register starting Aug. 11 at 6:30 AM. You will have 48 hours to decide.';

  it('accepts a reading whose evidence and year both appear in the page', () => {
    expect(corroborationFailure(PAGE, extracted())).toBeNull();
  });

  it('rejects an invented quote', () => {
    // The whole point: a date the page does not contain cannot survive a check
    // that looks for it in the page.
    expect(
      corroborationFailure(PAGE, extracted({ evidence: 'Register starting Sep. 2 at 6:30 AM' })),
    ).toBe('uncorroborated');
  });

  it('rejects a year the page never states for this cycle', () => {
    // THE STALE-YEAR TRAP, structurally. A 2025 date cannot be reported off a
    // page whose only year is 2026.
    expect(
      corroborationFailure(
        PAGE,
        extracted({
          generalOpen: { date: '2025-08-11', time: '06:30' },
        }),
      ),
    ).toBe('uncorroborated');
  });

  it('rejects year evidence that is not on the page', () => {
    expect(
      corroborationFailure(PAGE, extracted({ yearEvidence: '2026 Winter Programs' })),
    ).toBe('uncorroborated');
  });

  it('tolerates whitespace and dash differences the HTML strip introduces', () => {
    // The model re-types a quote with a normal hyphen and single spaces; the
    // stripped page has an en dash and a run of spaces. That is not fabrication.
    const page = '2026 Fall Programs.  Register  starting Aug. 11 – 6:30 AM.';
    expect(
      corroborationFailure(
        page,
        extracted({
          yearEvidence: '2026 Fall Programs',
          evidence: 'Register starting Aug. 11 - 6:30 AM',
        }),
      ),
    ).toBeNull();
  });

  it('does not gate a not-found answer — there is nothing to corroborate', () => {
    expect(
      corroborationFailure(
        PAGE,
        extracted({
          found: false,
          reason: 'announced_later',
          evidence: null,
          yearEvidence: null,
          preview: null,
          residentOpen: null,
          generalOpen: null,
        }),
      ),
    ).toBeNull();
  });
});
