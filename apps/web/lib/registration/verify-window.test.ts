import { strictToolSchema } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  EXTRACTION_JSON_SCHEMA,
  type ExtractedWindow,
  type PublishedDate,
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
    preview: {
      quote: 'Aug, 3',
      dateText: 'Aug, 3',
      timeText: null,
      date: '2026-08-03',
      time: null,
    },
    residentOpen: null,
    generalOpen: {
      quote: 'Aug. 11 at 6:30 AM',
      dateText: 'Aug. 11',
      timeText: '6:30 AM',
      date: '2026-08-11',
      time: '06:30',
    },
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
        residentOpen: {
          quote: 'June 5, 2026, at 7 a.m.',
          dateText: 'June 5, 2026',
          timeText: '7 a.m.',
          date: '2026-06-05',
          time: '07:00',
        },
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
        preview: {
          quote: 'Jan. 5',
          dateText: 'Jan. 5',
          timeText: null,
          date: '2027-01-05',
          time: null,
        },
        generalOpen: {
          quote: 'Jan. 12 at 9 a.m.',
          dateText: 'Jan. 12',
          timeText: '9 a.m.',
          date: '2027-01-12',
          time: '09:00',
        },
        evidence: 'Registration opens Jan. 12 at 9 a.m.',
      }),
    );
    expect(outcome).toEqual({ kind: 'confirmed', fields: ['previewAt', 'residentOpenAt'] });
  });

  it('leaves a page that labels both dates alone', () => {
    const outcome = compareWindow(
      tiered(),
      extracted({
        residentOpen: {
          quote: 'Aug. 11 at 6:30 AM',
          dateText: 'Aug. 11',
          timeText: '6:30 AM',
          date: '2026-08-11',
          time: '06:30',
        },
        generalOpen: {
          quote: 'Aug. 12 at 6:30 AM',
          dateText: 'Aug. 12',
          timeText: '6:30 AM',
          date: '2026-08-12',
          time: '06:30',
        },
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
        generalOpen: {
          quote: 'Aug. 18 at 6:30 AM',
          dateText: 'Aug. 18',
          timeText: '6:30 AM',
          date: '2026-08-18',
          time: '06:30',
        },
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
        generalOpen: {
          quote: 'Aug. 11 at 7:00 AM',
          dateText: 'Aug. 11',
          timeText: '7:00 AM',
          date: '2026-08-11',
          time: '07:00',
        },
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
        residentOpen: {
          quote: 'Aug. 4 at 6:30 AM',
          dateText: 'Aug. 4',
          timeText: '6:30 AM',
          date: '2026-08-04',
          time: '06:30',
        },
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
        generalOpen: {
          quote: 'Aug. 18 at 6:30 AM',
          dateText: 'Aug. 18',
          timeText: '6:30 AM',
          date: '2026-08-18',
          time: '06:30',
        },
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
        generalOpen: {
          quote: 'Sep. 1 at 6:30 AM',
          dateText: 'Sep. 1',
          timeText: '6:30 AM',
          date: '2026-09-01',
          time: '06:30',
        },
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
      preview: {
        quote: 'Aug, 3',
        date_text: 'Aug, 3',
        time_text: null,
        date: '2026-08-03',
        time: null,
      },
    });
    expect(parsed.preview).toEqual({
      quote: 'Aug, 3',
      dateText: 'Aug, 3',
      timeText: null,
      date: '2026-08-03',
      time: null,
    });
  });

  it('keeps a QUOTED {date:null} as a partial date, never as a date field', () => {
    const parsed = parseExtraction({
      ...RAW,
      unclassified_open: {
        quote: 'August 11',
        date_text: 'August 11',
        time_text: null,
        date: null,
        time: null,
      },
    });
    expect(parsed.unclassifiedOpen).toBeNull();
    expect(parsed.partialDates).toEqual([{ kind: 'unclassified_open', quote: 'August 11' }]);
  });

  it('still rejects a malformed date — the collapse is not a catch-all', () => {
    expect(() =>
      parseExtraction({
        ...RAW,
        preview: {
          quote: 'August 3',
          date_text: 'August 3',
          time_text: null,
          date: 'August 3',
          time: null,
        },
      }),
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
          generalOpen: {
            quote: 'Aug. 11 at 6:30 AM',
            dateText: 'Aug. 11',
            timeText: '6:30 AM',
            date: '2025-08-11',
            time: '06:30',
          },
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
          generalOpen: {
            quote: 'Aug. 11 - 6:30 AM',
            dateText: 'Aug. 11',
            timeText: '6:30 AM',
            date: '2026-08-11',
            time: '06:30',
          },
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

/**
 * Every complete date names the characters of its own quote that state its date
 * (`dateText`) and its time (`timeText`). Code checks the labels, never a guess at which
 * number is which: each span is in the quote, the two do not overlap, the date span parses
 * WHOLE under the date grammar to exactly this month and day (and year, when it prints one),
 * and the time span parses WHOLE under the clock grammar to exactly this HH:MM. Numbers
 * outside the spans (an age, a room) are never read. Each refusal logs its own name.
 */
describe('corroborationFailure — every date is read from its own labelled spans', () => {
  type Labels = Pick<PublishedDate, 'quote' | 'dateText' | 'timeText' | 'date' | 'time'>;

  /** The gate's verdict and the refusal it logged, on a page that prints `quote` once. */
  function verdict(published: Labels) {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const result = corroborationFailure(
        `2026 Fall Programs. Register starting ${published.quote}.`,
        extracted({
          yearEvidence: '2026 Fall Programs',
          evidence: `Register starting ${published.quote}.`,
          preview: null,
          generalOpen: published,
        }),
      );
      const logged = info.mock.calls.find(
        ([, message]) => message === 'registration date: refused',
      );
      return {
        result,
        refusal: (logged?.[0] as { refusal?: string } | undefined)?.refusal ?? null,
      };
    } finally {
      info.mockRestore();
    }
  }
  const label = (
    quote: string,
    dateText: string,
    timeText: string | null,
    date: string,
    time: string | null,
  ): Labels => ({ quote, dateText, timeText, date, time });
  const ACCEPTED = { result: null, refusal: null };
  const refused = (refusal: string) => ({ result: 'uncorroborated', refusal });

  describe('a number beside the date is never the date', () => {
    it("refuses 'November 11 8+' read as Aug 11: the labelled date says November", () => {
      expect(verdict(label('November 11 8+', 'November 11', null, '2026-08-11', null))).toEqual(
        refused('date_mismatch'),
      );
    });

    it("refuses a date span that swallows the age: 'November 11 8'", () => {
      expect(verdict(label('November 11 8+', 'November 11 8', null, '2026-08-11', null))).toEqual(
        refused('date_unparsed'),
      );
    });

    it("accepts 'November 11 8+' as Nov 11 (control)", () => {
      expect(verdict(label('November 11 8+', 'November 11', null, '2026-11-11', null))).toEqual(
        ACCEPTED,
      );
    });

    it('accepts an age after the date with no time; the age is never parsed (control)', () => {
      expect(
        verdict(label('Aug 11 for ages 8 and up', 'Aug 11', null, '2026-08-11', null)),
      ).toEqual(ACCEPTED);
    });

    it('refuses the same quote with a time: no clock span stands behind 08:00', () => {
      expect(
        verdict(label('Aug 11 for ages 8 and up', 'Aug 11', null, '2026-08-11', '08:00')),
      ).toEqual(refused('span_missing'));
    });

    it('refuses the age labelled as the clock', () => {
      expect(
        verdict(label('Aug 11 for ages 8 and up', 'Aug 11', '8', '2026-08-11', '08:00')),
      ).toEqual(refused('time_unparsed'));
    });
  });

  describe("a clock's minute is never the day", () => {
    it('refuses a date span that runs into the clock', () => {
      expect(
        verdict(label('Aug. 8:30 a.m.', 'Aug. 8:30', '8:30 a.m.', '2026-08-30', '08:00')),
      ).toEqual(refused('span_overlap'));
    });

    it('refuses a month with no day of its own', () => {
      expect(verdict(label('Aug. 8:30 a.m.', 'Aug.', '8:30 a.m.', '2026-08-30', '08:30'))).toEqual(
        refused('date_unparsed'),
      );
    });

    it('refuses the minute labelled as the day', () => {
      expect(verdict(label('Aug. 8:30 a.m.', 'Aug. 8:30', null, '2026-08-30', null))).toEqual(
        refused('date_unparsed'),
      );
    });
  });

  describe('an all-numeric date is read only when it cannot be the other way round', () => {
    it.each([
      ['day first', '2026-08-11'],
      ['month first', '2026-11-08'],
    ])("refuses '11/08/2026' read %s as ambiguous", (_name, date) => {
      expect(verdict(label('11/08/2026', '11/08/2026', null, date, null))).toEqual(
        refused('date_ambiguous'),
      );
    });

    it.each([
      ['a day above 12 first', '15/08/2026'],
      ['a day above 12 second', '08/15/2026'],
    ])('accepts %s as Aug 15 (control)', (_name, printed) => {
      expect(verdict(label(printed, printed, null, '2026-08-15', null))).toEqual(ACCEPTED);
    });

    it("refuses '15/08/2026' read as another day", () => {
      expect(verdict(label('15/08/2026', '15/08/2026', null, '2026-08-16', null))).toEqual(
        refused('date_mismatch'),
      );
    });

    it("accepts the day equal to the month: '08/08/2026' (control)", () => {
      expect(verdict(label('08/08/2026', '08/08/2026', null, '2026-08-08', null))).toEqual(
        ACCEPTED,
      );
    });

    it.each([
      ['with no time', null, null],
      ['with the month read as the hour', null, '08:00'],
    ])("refuses '11 08 2026' %s: it is not in the date grammar", (_name, timeText, time) => {
      expect(verdict(label('11 08 2026', '11 08 2026', timeText, '2026-08-11', time)).result).toBe(
        'uncorroborated',
      );
    });
  });

  describe('the labels must be the quote’s own, separate characters', () => {
    it('refuses a date span that is not in the quote', () => {
      expect(
        verdict(label('Aug. 11 at 6:30 AM', 'Aug. 12', '6:30 AM', '2026-08-12', '06:30')),
      ).toEqual(refused('span_missing'));
    });

    it('refuses a time span that is not in the quote', () => {
      expect(
        verdict(label('Aug. 11 at 6:30 AM', 'Aug. 11', '7:30 AM', '2026-08-11', '07:30')),
      ).toEqual(refused('span_missing'));
    });

    it('refuses an empty date span', () => {
      expect(verdict(label('Aug. 11 at 6:30 AM', ' ', '6:30 AM', '2026-08-11', '06:30'))).toEqual(
        refused('span_missing'),
      );
    });

    it('refuses overlapping spans', () => {
      expect(
        verdict(label('Aug. 11 at 6:30 AM', 'Aug. 11 at 6', '6:30 AM', '2026-08-11', '06:30')),
      ).toEqual(refused('span_overlap'));
    });

    it('refuses a time span with no time', () => {
      expect(
        verdict(label('Aug. 11 at 6:30 AM', 'Aug. 11', '6:30 AM', '2026-08-11', null)),
      ).toEqual(refused('time_mismatch'));
    });
  });

  describe('a label starts and ends where the quote’s own words and numbers do', () => {
    it.each([
      ['a day cut from the year', label('Sept. 2026', 'Sept. 20', null, '2026-09-20', null)],
      ['a one-digit day cut from the year', label('Aug 2026', 'Aug 2', null, '2026-08-02', null)],
      [
        'a day cut from the year, beside a clock',
        label('Sept 2026 9 a.m.', 'Sept 2', '9 a.m.', '2026-09-02', '09:00'),
      ],
      ['a month cut from a word', label('Grammar 3', 'mar 3', null, '2026-03-03', null)],
      [
        'a clock cut from a longer hour',
        label('Aug. 11 at 10:30', 'Aug. 11', '0:30', '2026-08-11', '00:30'),
      ],
    ])('refuses %s', (_name, labels) => {
      expect(verdict(labels)).toEqual(refused('span_missing'));
    });

    it('accepts a day the quote prints whole (control)', () => {
      expect(verdict(label('Aug. 20, 2026', 'Aug. 20', null, '2026-08-20', null))).toEqual(
        ACCEPTED,
      );
    });
  });

  /**
   * A day-first date runs straight into its clock (`11 août 20h00`), so the month and the
   * hour also read as a date (`août 20`). That expression straddles the two labels: it is
   * the seam between them, not a third value.
   */
  describe('a day-first date followed by its clock', () => {
    it.each([
      ['fr, 20h00', label('11 août 20h00', '11 août', '20h00', '2026-08-11', '20:00')],
      [
        'fr, a weekday and 18 h 30',
        label('lundi 7 décembre 18 h 30', 'lundi 7 décembre', '18 h 30', '2026-12-07', '18:30'),
      ],
      ['es', label('11 de agosto 9:00', '11 de agosto', '9:00', '2026-08-11', '09:00')],
      ['en', label('11 Aug 9 a.m.', '11 Aug', '9 a.m.', '2026-08-11', '09:00')],
    ])('accepts %s', (_name, labels) => {
      expect(verdict(labels)).toEqual(ACCEPTED);
    });

    it('refuses the hour read as the day', () => {
      expect(verdict(label('11 Aug 9 a.m.', '11 Aug', '9 a.m.', '2026-08-09', '09:00'))).toEqual(
        refused('date_mismatch'),
      );
    });

    it('refuses no time beside the printed clock', () => {
      // With no time label there is no seam, so `août 20` and `20h00` both disagree.
      expect(verdict(label('11 août 20h00', '11 août', null, '2026-08-11', null)).result).toBe(
        'uncorroborated',
      );
    });

    it('refuses a prior-year date before its clock', () => {
      expect(
        verdict(label('11 août 2025 20h00', '11 août', '20h00', '2026-08-11', '20:00')),
      ).toEqual(refused('date_mismatch'));
    });

    it('refuses a second date that only touches the clock', () => {
      expect(
        verdict(label('Aug 11 Aug 9 a.m.', 'Aug 11', '9 a.m.', '2026-08-11', '09:00')),
      ).toEqual(refused('date_mismatch'));
    });
  });

  /**
   * Each label is checked on its own, not only through the scan of the whole quote: these
   * labels sit inside a longer expression that does state the reading, so the scan alone
   * would pass them.
   */
  describe('a label inside a longer expression must itself state the value', () => {
    it("refuses 'mar. 3' (March 3) labelled inside 'mar. 3 août' (Tuesday, Aug 3)", () => {
      expect(verdict(label('mar. 3 août', 'mar. 3', null, '2026-08-03', null))).toEqual(
        refused('date_mismatch'),
      );
    });

    it("accepts the whole 'mar. 3 août' as Aug 3 (control)", () => {
      expect(verdict(label('mar. 3 août', 'mar. 3 août', null, '2026-08-03', null))).toEqual(
        ACCEPTED,
      );
    });

    it("refuses '05 p.m.' (17:00) labelled inside '1:05 p.m.' read as 13:05", () => {
      expect(
        verdict(label('Aug. 11 at 1:05 p.m.', 'Aug. 11', '05 p.m.', '2026-08-11', '13:05')),
      ).toEqual(refused('time_mismatch'));
    });
  });

  describe('each span says exactly the extracted value', () => {
    it.each([
      ['another day', 'Aug. 11', '6:30 AM', '2026-08-12', '06:30', 'date_mismatch'],
      [
        'another year than the span prints',
        'Aug. 11, 2027',
        null,
        '2026-08-11',
        null,
        'date_mismatch',
      ],
      ['another hour', 'Aug. 11', '6:30 AM', '2026-08-11', '07:30', 'time_mismatch'],
      ['another minute', 'Aug. 11', '6:30 AM', '2026-08-11', '06:45', 'time_mismatch'],
      ['the evening', 'Aug. 11', '6:30 AM', '2026-08-11', '18:30', 'time_mismatch'],
    ] as const)('refuses %s', (_name, dateText, timeText, date, time, refusal) => {
      const quote = dateText.includes('2027') ? 'Aug. 11, 2027' : 'Aug. 11 at 6:30 AM';
      expect(verdict(label(quote, dateText, timeText, date, time))).toEqual(refused(refusal));
    });

    it.each([
      ['noon', 'Aug. 11 at noon', 'noon', '12:00'],
      ['midnight', 'Aug. 11 at midnight', 'midnight', '00:00'],
      ['a dotted clock', 'Aug. 11 at 8.30', '8.30', '08:30'],
      ['a bare hour', 'Aug. 11 at 8', '8', '08:00'],
      ['a meridiem on a 24-hour clock', 'Aug. 11 at 18:30 pm', '18:30 pm', '18:30'],
    ] as const)('refuses a clock outside the grammar: %s', (_name, quote, timeText, time) => {
      expect(verdict(label(quote, 'Aug. 11', timeText, '2026-08-11', time))).toEqual(
        refused('time_unparsed'),
      );
    });
  });

  /**
   * The spans are the model's labels; the quote is the page's words. Every date and every
   * clock the quote prints must state the extracted value too, so a label cannot pick a
   * day from one expression and leave a conflicting year, date or clock beside it.
   */
  describe('every date and clock the quote prints agrees with the reading', () => {
    it('refuses a prior-year opening labelled without its year', () => {
      expect(
        verdict(label('Aug. 11, 2025 at 9 a.m.', 'Aug. 11', '9 a.m.', '2026-08-11', '09:00')),
      ).toEqual(refused('date_mismatch'));
    });

    it('accepts the same labels when the printed year is this one (control)', () => {
      expect(
        verdict(label('Aug. 11, 2026 at 9 a.m.', 'Aug. 11', '9 a.m.', '2026-08-11', '09:00')),
      ).toEqual(ACCEPTED);
    });

    it('accepts a weekday the label leaves out: the longer date still says Aug 11 (control)', () => {
      expect(
        verdict(label('Tuesday, Aug. 11 at 9 a.m.', 'Aug. 11', '9 a.m.', '2026-08-11', '09:00')),
      ).toEqual(ACCEPTED);
    });

    it.each([
      ['the preview day with the opening clock', 'Aug. 11', '2026-08-11'],
      ['the opening day, beside a preview day', 'Aug. 12', '2026-08-12'],
    ])('refuses a quote that prints two dates: %s', (_name, dateText, date) => {
      const quote = 'Preview Aug. 11; registration opens Aug. 12 at 9 a.m.';
      expect(verdict(label(quote, dateText, '9 a.m.', date, '09:00'))).toEqual(
        refused('date_mismatch'),
      );
    });

    it('refuses a table row whose labels are its last cell', () => {
      expect(
        verdict(
          label('Aug. 20 7 a.m. | Aug. 22 9 a.m.', 'Aug. 22', '9 a.m.', '2026-08-22', '09:00'),
        ),
      ).toEqual(refused('date_mismatch'));
    });

    it("accepts the date's own cell (control)", () => {
      expect(verdict(label('Aug. 22 9 a.m.', 'Aug. 22', '9 a.m.', '2026-08-22', '09:00'))).toEqual(
        ACCEPTED,
      );
    });

    it('refuses a quote that prints a second clock', () => {
      expect(
        verdict(label('Aug 11 8:00 to 9:15', 'Aug 11', '8:00', '2026-08-11', '08:00')),
      ).toEqual(refused('time_mismatch'));
    });

    it('refuses no time when the quote prints one', () => {
      expect(verdict(label('Aug. 11 at 6:30 AM', 'Aug. 11', null, '2026-08-11', null))).toEqual(
        refused('time_mismatch'),
      );
    });

    it('reads a clock whole, never the minute and meridiem inside it (control)', () => {
      // `05 p.m.` sits inside `1:05 p.m.`; read alone it would be 17:00.
      expect(
        verdict(label('Aug. 11 at 1:05 p.m.', 'Aug. 11', '1:05 p.m.', '2026-08-11', '13:05')),
      ).toEqual(ACCEPTED);
    });
  });

  describe('the grammars read what pages print (controls)', () => {
    it.each([
      ['H:MM AM', 'Aug. 11 at 6:30 AM', 'Aug. 11', '6:30 AM', '2026-08-11', '06:30'],
      ['H:MM PM', 'Aug. 11 at 6:30 PM', 'Aug. 11', '6:30 PM', '2026-08-11', '18:30'],
      ['8:00', '2026-08-11 8:00', '2026-08-11', '8:00', '2026-08-11', '08:00'],
      ['8 a.m.', 'Aug. 11 8 a.m.', 'Aug. 11', '8 a.m.', '2026-08-11', '08:00'],
      ['8 a.m. after a comma', 'Aug. 11, 8 a.m.', 'Aug. 11', '8 a.m.', '2026-08-11', '08:00'],
      ['8:00 after a dash', 'Aug 11 - 8:00', 'Aug 11', '8:00', '2026-08-11', '08:00'],
      ['12 p.m.', 'Aug. 11 at 12 p.m.', 'Aug. 11', '12 p.m.', '2026-08-11', '12:00'],
      ['20h00', '11 août 2026 20h00', '11 août 2026', '20h00', '2026-08-11', '20:00'],
      [
        '18 h 30',
        'lundi 7 décembre 2026 à 18 h 30',
        'lundi 7 décembre 2026',
        '18 h 30',
        '2026-12-07',
        '18:30',
      ],
      [
        '9 h, a whole French hour',
        'vendredi 11 décembre 2026 à 9 h',
        'vendredi 11 décembre 2026',
        '9 h',
        '2026-12-11',
        '09:00',
      ],
      ['8点', '2026年8月11日8点', '2026年8月11日', '8点', '2026-08-11', '08:00'],
      ['8点半', '8月11日8点半', '8月11日', '8点半', '2026-08-11', '08:30'],
      ['8時30分', '8月11日8時30分', '8月11日', '8時30分', '2026-08-11', '08:30'],
      ['8시', '2026-08-11 8시', '2026-08-11', '8시', '2026-08-11', '08:00'],
      [
        'es, de',
        '11 de agosto de 2026 a las 8:00',
        '11 de agosto de 2026',
        '8:00',
        '2026-08-11',
        '08:00',
      ],
      [
        'a weekday and a year',
        'Tuesday, August 11, 2026 at 7:00 p.m.',
        'Tuesday, August 11, 2026',
        '7:00 p.m.',
        '2026-08-11',
        '19:00',
      ],
      ['the time before the date', '9 a.m. on Aug. 11', 'Aug. 11', '9 a.m.', '2026-08-11', '09:00'],
      ['ISO with a slash', '2026/08/11', '2026/08/11', null, '2026-08-11', null],
      ['the source’s comma typo', 'Aug, 3', 'Aug, 3', null, '2026-08-03', null],
      ['an ordinal', 'August 11th at 9 a.m.', 'August 11th', '9 a.m.', '2026-08-11', '09:00'],
    ] as const)('accepts %s', (_name, quote, dateText, timeText, date, time) => {
      expect(verdict(label(quote, dateText, timeText, date, time))).toEqual(ACCEPTED);
    });

    it('accepts digits the page prints full-width or behind a no-break space', () => {
      const page =
        '2026 Fall Programs, Swim Lessons and Winter Break Camps. Preview starting Aug, 3. Register starting Aug. １１ at 6:30 AM.';
      expect(corroborationFailure(page, extracted())).toBeNull();
    });
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
          generalOpen: {
            quote: 'August 11',
            dateText: 'August 11',
            timeText: null,
            date: '2026-08-11',
            time: null,
          },
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

  it('asks for the date and time spans before the values they justify', () => {
    const slot = Object.keys(EXTRACTION_JSON_SCHEMA.$defs.publishedDate.properties);
    expect(slot).toEqual(['quote', 'date_text', 'time_text', 'date', 'time']);
    expect(EXTRACTION_JSON_SCHEMA.$defs.publishedDate.required).toEqual(slot);
  });

  it('bounds the length of every string the model writes', () => {
    const strings: string[] = [];
    const unbounded: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      const type = schema.type;
      if (type === 'string' || (Array.isArray(type) && type.includes('string'))) {
        strings.push(path);
        if (!schema.enum && typeof schema.maxLength !== 'number') unbounded.push(path);
      }
      for (const key of ['properties', '$defs']) {
        const children = schema[key];
        if (!children || typeof children !== 'object') continue;
        for (const [name, child] of Object.entries(children)) walk(child, `${path}.${name}`);
      }
    };
    walk(EXTRACTION_JSON_SCHEMA, '');
    // Positive control: the walk reaches the free-text fields it is meant to bound.
    expect(strings).toEqual(
      expect.arrayContaining([
        '.evidence',
        '.note',
        '.publishedDate.quote',
        '.publishedDate.date_text',
        '.publishedDate.time_text',
      ]),
    );
    expect(unbounded).toEqual([]);
  });

  /** Every free-text field and the bound the JSON schema states for it. `date` and `time`
   * are left out: their format regex bounds them more tightly than any length. */
  const freeText = [
    ...[
      'cycle_on_page',
      'evidence',
      'year_evidence',
      'time_zone_evidence',
      'time_zone',
      'eligibility_evidence',
      'note',
    ].map((field) => ({ field, slotField: null })),
    ...['quote', 'date_text', 'time_text'].map((slotField) => ({
      field: 'general_open',
      slotField,
    })),
  ] as const;
  const bound = (field: string, slotField: string | null) => {
    const node = slotField
      ? EXTRACTION_JSON_SCHEMA.$defs.publishedDate.properties[
          slotField as keyof typeof EXTRACTION_JSON_SCHEMA.$defs.publishedDate.properties
        ]
      : EXTRACTION_JSON_SCHEMA.properties[field as keyof typeof EXTRACTION_JSON_SCHEMA.properties];
    return (node as { maxLength: number }).maxLength;
  };
  const answerWith = (field: string, slotField: string | null, text: string) => {
    const slot = {
      quote: 'Aug. 11',
      date_text: 'Aug. 11',
      time_text: null,
      date: null,
      time: null,
    };
    return {
      cycle_on_page: 'Fall 2026',
      evidence: null,
      year_evidence: null,
      time_zone_evidence: null,
      time_zone: null,
      eligibility_evidence: null,
      preview: null,
      resident_open: null,
      general_open: slotField ? { ...slot, [slotField]: text } : slot,
      unclassified_open: null,
      note: null,
      found: true,
      reason: null,
      confidence: 0.9,
      ...(slotField ? {} : { [field]: text }),
    };
  };

  it.each(freeText)(
    'enforces the schema bound on $field $slotField at the parse, so overlong text never reaches the gate',
    ({ field, slotField }) => {
      const limit = bound(field, slotField);
      expect(limit).toBeGreaterThan(0);
      expect(() => parseExtraction(answerWith(field, slotField, 'x'.repeat(limit + 1)))).toThrow();
      // Positive control: text at the bound parses.
      expect(() => parseExtraction(answerWith(field, slotField, 'x'.repeat(limit)))).not.toThrow();
    },
  );
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
    unclassifiedOpen: {
      quote: 'Aug. 11 at 6:30 AM',
      dateText: 'Aug. 11',
      timeText: '6:30 AM',
      date: '2026-08-11',
      time: '06:30',
    },
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
      generalOpen: {
        quote: 'August 11, 2026',
        dateText: 'August 11, 2026',
        timeText: null,
        date: '2026-08-11',
        time: null,
      },
    });
    expect(isTrustworthyFind(PAGE, complete)).toBe(true);
  });
});
