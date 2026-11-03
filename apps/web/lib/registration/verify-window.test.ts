import { strictToolSchema } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_JSON_SCHEMA,
  type ExtractedWindow,
  type StoredWindow,
  type VerifyField,
  type VerifyOutcome,
  compareWindow,
  corroborationFailure,
  isTrustworthyFind,
  parseExtraction,
  publishedInstant,
  withoutInferredEvidence,
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
    district: null,
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
    evidence: 'Register starting Aug. 11 at 6:30 AM',
    preview: { quote: 'Aug, 3', date: '2026-08-03', time: null },
    residentOpen: null,
    generalOpen: { quote: 'Aug. 11 at 6:30 AM', date: '2026-08-11', time: '06:30' },
    unclassifiedOpen: null,
    partialDates: [],
    timeZone: null,
    timeZoneEvidence: null,
    note: null,
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
        residentOpen: { quote: 'June 5, 2026, at 7 a.m.', date: '2026-06-05', time: '07:00' },
        generalOpen: null,
      }),
    );
    expect(outcome).toEqual({ kind: 'confirmed', fields: ['residentOpenAt'] });
  });
});

/**
 * VIL-347 — Markham's shape: the course pages tier the cycle (residents Aug 11, everyone
 * else Aug 12) and the city page a parent is sent to prints ONE unlabelled date, "Register
 * starting Aug. 11 at 6:30 AM". Read naively that single date is the general open, so the
 * row disagrees with its own source every Monday, forever, and `verified_at` freezes while
 * the founder digest repeats the same diff.
 *
 * The rule that resolves it names no municipality and keeps no list: it is the doctrine
 * already written above ("only the fields the page states are compared") applied to a page
 * that MISLABELS rather than omits.
 */
describe('compareWindow — a page that states one unlabelled date', () => {
  /** Stored as the course pages publish it; the page still prints only Aug 11. */
  const tiered = (overrides: Partial<StoredWindow> = {}) =>
    markhamStored({
      residentOpenAt: new Date('2026-08-11T06:30:00-04:00'),
      openAt: new Date('2026-08-12T06:30:00-04:00'),
      ...overrides,
    });

  it('reads it as the RESIDENT date when that is what it matches', () => {
    const outcome = compareWindow(tiered(), extracted());
    expect(outcome).toEqual({ kind: 'confirmed', fields: ['previewAt', 'residentOpenAt'] });
  });

  // The control, and the whole reason this is not an exemption list: the rule fires only
  // on a date that MATCHES something stored. A row whose resident date is genuinely wrong
  // still alarms, and the page's date is still reported against the field it was read as.
  it('still alarms when the single date matches neither stored date', () => {
    const outcome = compareWindow(
      tiered({ residentOpenAt: new Date('2026-08-10T06:30:00-04:00') }),
      extracted(),
    );
    expect(outcome.kind).toBe('discrepancy');
    if (outcome.kind !== 'discrepancy') throw new Error('expected a discrepancy');
    expect(outcome.diffs).toEqual([
      {
        field: 'openAt',
        stored: new Date('2026-08-12T06:30:00-04:00'),
        published: new Date('2026-08-11T06:30:00-04:00'),
      },
    ]);
  });

  /**
   * THE RULE IS THE ROW'S, NOT MARKHAM'S. Every other fixture in this file is a Markham
   * one, so a rule quietly gated on the municipality would pass all of them — this is a
   * different town, on dates of its own, in the identical shape. It fails the moment the
   * rule consults anything but `stored.residentOpenAt` and the page's own two fields.
   * (The dates are a shape, not a published claim about Vaughan.)
   */
  it('fires for any town whose page prints one date, not a named list of them', () => {
    const outcome = compareWindow(
      markhamStored({
        id: 'win-vaughan-winter',
        municipality: 'vaughan',
        cycleLabel: '2027 Winter Programs',
        previewAt: new Date('2027-01-05T00:00:00-05:00'),
        residentOpenAt: new Date('2027-01-12T09:00:00-05:00'),
        openAt: new Date('2027-01-14T09:00:00-05:00'),
      }),
      extracted({
        cycleOnPage: '2027 Winter Programs',
        yearEvidence: '2027 Winter Programs',
        preview: { quote: 'Jan. 5', date: '2027-01-05', time: null },
        generalOpen: { quote: 'Jan. 12 at 9 a.m.', date: '2027-01-12', time: '09:00' },
        evidence: 'Registration opens Jan. 12 at 9 a.m.',
      }),
    );
    expect(outcome).toEqual({ kind: 'confirmed', fields: ['previewAt', 'residentOpenAt'] });
  });

  it('leaves a page that labels both dates alone', () => {
    const outcome = compareWindow(
      tiered(),
      extracted({
        residentOpen: { quote: 'Aug. 11 at 6:30 AM', date: '2026-08-11', time: '06:30' },
        generalOpen: { quote: 'Aug. 12 at 6:30 AM', date: '2026-08-12', time: '06:30' },
      }),
    );
    expect(outcome).toEqual({
      kind: 'confirmed',
      fields: ['previewAt', 'residentOpenAt', 'openAt'],
    });
  });
});

/**
 * VIL-347 — the other half of the unlabelled-date rule. That rule reads the page's single
 * date as the resident one on the strength of a match; the dataset separately knows which
 * rows hold a field they never read off their own source (Markham's swim and camp rows
 * carry the head start from the REC: Programs course pages of the same cycle). Those two
 * together could otherwise launder an inference into a confirmation: a page silent about
 * the tier would "confirm" a tier nobody ever read for that domain.
 */
describe('withoutInferredEvidence', () => {
  const confirmed = (...fields: VerifyField[]): VerifyOutcome => ({ kind: 'confirmed', fields });

  it('leaves an outcome alone when the row inferred nothing — the ordinary row', () => {
    const outcome = confirmed('previewAt', 'residentOpenAt');
    expect(withoutInferredEvidence(outcome, [])).toEqual(outcome);
  });

  it('drops an inferred field from the evidence, keeping what the page really said', () => {
    expect(
      withoutInferredEvidence(confirmed('previewAt', 'residentOpenAt'), ['residentOpenAt']),
    ).toEqual(confirmed('previewAt'));
  });

  it('is not a confirmation at all when the inference was the only evidence', () => {
    expect(withoutInferredEvidence(confirmed('residentOpenAt'), ['residentOpenAt'])).toEqual({
      kind: 'unverified',
      reason: 'inferred_unconfirmed',
    });
  });

  it('never softens a discrepancy — a page that contradicts an inference still alarms', () => {
    const outcome: VerifyOutcome = {
      kind: 'discrepancy',
      diffs: [
        {
          field: 'residentOpenAt',
          stored: new Date('2026-08-11T06:30:00-04:00'),
          published: new Date('2026-08-10T06:30:00-04:00'),
        },
      ],
      evidence: 'Residents register Aug. 10',
    };
    expect(withoutInferredEvidence(outcome, ['residentOpenAt'])).toEqual(outcome);
  });
});

describe('compareWindow — discrepancy NEVER becomes a change', () => {
  it('reports a moved date as a discrepancy carrying both instants', () => {
    const stored = markhamStored();
    const outcome = compareWindow(
      stored,
      extracted({
        generalOpen: { quote: 'Aug. 18 at 6:30 AM', date: '2026-08-18', time: '06:30' },
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
      extracted({
        generalOpen: { quote: 'Aug. 11 at 7:00 AM', date: '2026-08-11', time: '07:00' },
      }),
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
      extracted({
        residentOpen: { quote: 'Aug. 4 at 6:30 AM', date: '2026-08-04', time: '06:30' },
      }),
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
      extracted({
        generalOpen: { quote: 'Aug. 18 at 6:30 AM', date: '2026-08-18', time: '06:30' },
      }),
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
      extracted({
        confidence: 0.3,
        generalOpen: { quote: 'Sep. 1 at 6:30 AM', date: '2026-09-01', time: '06:30' },
      }),
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

describe('parseExtraction — {date:null} is the same absence as null', () => {
  // A full, valid model answer; each case overrides only the `preview` field.
  const RAW = {
    cycle_on_page: '2026 Fall Programs',
    evidence: 'Register starting Aug. 11 at 6:30 AM',
    year_evidence: '2026 Fall Programs',
    time_zone_evidence: null,
    time_zone: null,
    eligibility_evidence: null,
    preview: null,
    resident_open: null,
    general_open: null,
    unclassified_open: null,
    note: null,
    found: true,
    reason: null,
    confidence: 0.9,
  };

  it('collapses a {date:null} object to null — the model\'s other "no date" encoding', () => {
    // The model flip-flops between `null` and `{date:null,time:null}` for a slot
    // with no published date. Both must arrive as null: compareWindow's `=== null`
    // skip and publishedInstant both assume a PublishedDate carries a real date, so
    // an un-collapsed {date:null} would slip a null date into instant construction.
    const parsed = parseExtraction({ ...RAW, preview: { date: null, time: null } });
    expect(parsed.preview).toBeNull();
  });

  it('keeps a real published date (positive control)', () => {
    const parsed = parseExtraction({
      ...RAW,
      preview: { quote: 'Aug, 3', date: '2026-08-03', time: null },
    });
    expect(parsed.preview).toEqual({ quote: 'Aug, 3', date: '2026-08-03', time: null });
  });

  it('keeps a QUOTED {date:null} as a partial date, never as a date field', () => {
    const parsed = parseExtraction({
      ...RAW,
      unclassified_open: { quote: 'August 11', date: null, time: null },
    });
    expect(parsed.unclassifiedOpen).toBeNull();
    expect(parsed.partialDates).toEqual([{ kind: 'unclassified_open', quote: 'August 11' }]);
  });

  it('still rejects a malformed date — the collapse is not a catch-all', () => {
    expect(() =>
      parseExtraction({ ...RAW, preview: { quote: 'August 3', date: 'August 3', time: null } }),
    ).toThrow();
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
          generalOpen: { quote: 'Aug. 11 at 6:30 AM', date: '2025-08-11', time: '06:30' },
        }),
      ),
    ).toBe('uncorroborated');
  });

  it('rejects year evidence that is not on the page', () => {
    expect(corroborationFailure(PAGE, extracted({ yearEvidence: '2026 Winter Programs' }))).toBe(
      'uncorroborated',
    );
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
          preview: null,
          generalOpen: { quote: 'Aug. 11 - 6:30 AM', date: '2026-08-11', time: '06:30' },
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

describe('corroborationFailure — every date is bound to its own quote', () => {
  const PAGE =
    '2026 Fall Programs, Swim Lessons and Winter Break Camps. Preview starting Aug, 3. ' +
    'Register starting Aug. 11 at 6:30 AM. You will have 48 hours to decide.';
  const general = (quote: string, date: string, time: string | null) =>
    extracted({ generalOpen: { quote, date, time } });

  it('refuses a date whose quote is not on the page, though its numbers agree', () => {
    expect(corroborationFailure(PAGE, general('Aug. 11 at 6:30 PM', '2026-08-11', '18:30'))).toBe(
      'uncorroborated',
    );
  });

  it('accepts the same date quoted from the page (control)', () => {
    expect(
      corroborationFailure(PAGE, general('Aug. 11 at 6:30 AM', '2026-08-11', '06:30')),
    ).toBeNull();
  });

  it.each([
    ['another day', '2026-08-12', '06:30'],
    ['another hour', '2026-08-11', '07:30'],
    ['another minute', '2026-08-11', '06:45'],
    ['the day and the hour swapped', '2026-08-06', '11:30'],
    ['no time, when the quote prints one', '2026-08-11', null],
  ] as const)('refuses a date that disagrees with its own quote: %s', (_name, date, time) => {
    expect(corroborationFailure(PAGE, general('Aug. 11 at 6:30 AM', date, time))).toBe(
      'uncorroborated',
    );
  });

  describe('a month number counts only where it is printed beside the day', () => {
    const dateOnly = (sentence: string, quote: string) =>
      corroborationFailure(
        `2026 Fall Programs. ${sentence}`,
        extracted({
          yearEvidence: '2026 Fall Programs',
          evidence: sentence,
          preview: null,
          generalOpen: { quote, date: '2026-06-11', time: null },
        }),
      );

    it('refuses a date-only reading of a quote that prints an hour equal to the month', () => {
      expect(dateOnly('Register starting June 11 at 6 a.m.', 'June 11 at 6 a.m.')).toBe(
        'uncorroborated',
      );
    });

    it.each([
      ['ISO', 'Register starting 2026-06-11.', '2026-06-11'],
      ['day first', 'Register starting 11/06/2026.', '11/06/2026'],
      ['month first', 'Register starting 06/11/2026.', '06/11/2026'],
      ['CJK', '受付開始 2026年6月11日', '2026年6月11日'],
    ] as const)('accepts a numeric month beside the day: %s (control)', (_name, sentence, quote) => {
      expect(dateOnly(sentence, quote)).toBeNull();
    });
  });

  it('refuses a date whose quote prints another year', () => {
    const page = `${PAGE} Last season: Aug. 11, 2025 at 6:30 AM.`;
    expect(
      corroborationFailure(page, general('Aug. 11, 2025 at 6:30 AM', '2026-08-11', '06:30')),
    ).toBe('uncorroborated');
  });

  it.each([
    ['an afternoon clock', 'Register starting Aug. 11 at 6:30 PM.', 'Aug. 11 at 6:30 PM', '18:30'],
    ['a printed zero minute', 'Register starting Aug. 22 9:00 a.m.', 'Aug. 22 9:00 a.m.', '09:00'],
  ] as const)('accepts %s (control)', (_name, sentence, quote, time) => {
    const date = quote.includes('22') ? '2026-08-22' : '2026-08-11';
    expect(
      corroborationFailure(
        `2026 Fall Programs, Swim Lessons and Winter Break Camps. Preview starting Aug, 3. ${sentence}`,
        extracted({ evidence: sentence, generalOpen: { quote, date, time } }),
      ),
    ).toBeNull();
  });

  it('accepts digits the page prints full-width or behind a no-break space', () => {
    const page =
      '2026 Fall Programs, Swim Lessons and Winter Break Camps. Preview starting Aug, 3. Register starting Aug.\u00a0１１ at 6:30 AM.';
    expect(
      corroborationFailure(page, general('Aug. 11 at 6:30 AM', '2026-08-11', '06:30')),
    ).toBeNull();
  });
});

describe('corroborationFailure — a quote must state ONE date', () => {
  const PAGE =
    'Fall 2026 Registration Schedule | Fall swimming lessons | Aug. 12 | Aug. 20 7 a.m. | Aug. 22 9 a.m.';
  const resident = (quote: string) =>
    extracted({
      yearEvidence: 'Fall 2026 Registration Schedule',
      evidence: 'Fall swimming lessons | Aug. 12 | Aug. 20 7 a.m. | Aug. 22 9 a.m.',
      preview: null,
      generalOpen: null,
      residentOpen: { quote, date: '2026-08-22', time: '09:00' },
    });

  it('refuses a quote that spans two dates', () => {
    expect(corroborationFailure(PAGE, resident('Aug. 20 7 a.m. | Aug. 22 9 a.m.'))).toBe(
      'uncorroborated',
    );
  });

  it("accepts the date's own cell (control)", () => {
    expect(corroborationFailure(PAGE, resident('Aug. 22 9 a.m.'))).toBeNull();
  });
});

describe('corroborationFailure — year evidence is required only for a complete date', () => {
  const PAGE = 'Fall Programs. Preview August 4. Register August 11.';
  const partialOnly = extracted({
    yearEvidence: null,
    evidence: 'Preview August 4. Register August 11.',
    preview: null,
    generalOpen: null,
    partialDates: [
      { kind: 'preview', quote: 'August 4' },
      { kind: 'unclassified_open', quote: 'August 11' },
    ],
  });

  it('accepts yearless dates kept as partials with no year evidence', () => {
    expect(corroborationFailure(PAGE, partialOnly)).toBeNull();
  });

  it('refuses a complete date with no year evidence (control)', () => {
    expect(
      corroborationFailure(
        PAGE,
        extracted({
          ...partialOnly,
          generalOpen: { quote: 'August 11', date: '2026-08-11', time: null },
        }),
      ),
    ).toBe('uncorroborated');
  });
});

describe('EXTRACTION_JSON_SCHEMA', () => {
  it('stays grammar-expressible, with reasoning before verdicts and no no_year_stated', () => {
    expect(strictToolSchema(EXTRACTION_JSON_SCHEMA as never)).not.toBeNull();
    const keys = Object.keys(EXTRACTION_JSON_SCHEMA.properties);
    expect(keys.indexOf('eligibility_evidence')).toBeLessThan(keys.indexOf('general_open'));
    expect(keys.indexOf('evidence')).toBeLessThan(keys.indexOf('found'));
    expect(keys.indexOf('time_zone_evidence')).toBeLessThan(keys.indexOf('time_zone'));
    expect(EXTRACTION_JSON_SCHEMA.properties.reason.enum).not.toContain('no_year_stated');
    expect(EXTRACTION_JSON_SCHEMA.properties.reason.enum).toContain('announced_later');
  });
});

describe('compareWindow — an unlabelled opening is compared as before (VIL-347)', () => {
  const tiered = (overrides: Partial<StoredWindow> = {}) =>
    markhamStored({
      residentOpenAt: new Date('2026-08-11T06:30:00-04:00'),
      openAt: new Date('2026-08-12T06:30:00-04:00'),
      ...overrides,
    });
  const unlabelled = extracted({
    generalOpen: null,
    unclassifiedOpen: { quote: 'Aug. 11 at 6:30 AM', date: '2026-08-11', time: '06:30' },
  });

  it('reads it as the resident date when that is what it matches', () => {
    expect(compareWindow(tiered(), unlabelled)).toEqual({
      kind: 'confirmed',
      fields: ['previewAt', 'residentOpenAt'],
    });
  });

  it('still reports it against the general open when it matches neither', () => {
    const outcome = compareWindow(
      tiered({ residentOpenAt: new Date('2026-08-10T06:30:00-04:00') }),
      unlabelled,
    );
    if (outcome.kind !== 'discrepancy')
      throw new Error(`expected a discrepancy, got ${outcome.kind}`);
    expect(outcome.diffs.map((diff) => diff.field)).toEqual(['openAt']);
  });

  it('is incomplete_date when the page carried only yearless dates', () => {
    expect(
      compareWindow(
        markhamStored(),
        extracted({
          preview: null,
          generalOpen: null,
          partialDates: [{ kind: 'unclassified_open', quote: 'Aug. 11' }],
        }),
      ),
    ).toEqual({ kind: 'unverified', reason: 'incomplete_date' });
  });
});

describe('isTrustworthyFind — a find needs a complete date', () => {
  const PAGE = 'Fall Programs. Preview August 4. Register August 11, 2026.';
  const partialOnly = extracted({
    yearEvidence: null,
    evidence: 'Preview August 4.',
    preview: null,
    generalOpen: null,
    partialDates: [{ kind: 'preview', quote: 'August 4' }],
    confidence: 0.9,
  });

  it('refuses a corroborated reading of yearless dates alone', () => {
    expect(corroborationFailure(PAGE, partialOnly)).toBeNull();
    expect(isTrustworthyFind(PAGE, partialOnly)).toBe(false);
  });

  it('accepts one complete corroborated date (control)', () => {
    const complete = extracted({
      ...partialOnly,
      yearEvidence: 'August 11, 2026',
      evidence: 'Register August 11, 2026.',
      generalOpen: { quote: 'August 11, 2026', date: '2026-08-11', time: null },
    });
    expect(isTrustworthyFind(PAGE, complete)).toBe(true);
  });
});
