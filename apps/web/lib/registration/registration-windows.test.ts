import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { REGISTRATION_WINDOWS, type RegistrationWindowSeed } from './registration-windows-data.js';
import { syncRegistrationWindows, toRegistrationWindowRow } from './registration-windows.js';

/**
 * The registration-window seed: a pure row build that refuses to produce a row the
 * radar could lie with, plus an idempotent upsert on the natural
 * (municipality, program_domain, cycle_label) key. No database is touched — the row
 * build is pure and the write is asserted against a captured Drizzle chain.
 */

/** Captures the .insert().values(...).onConflictDoUpdate(...) chain. */
function fakeSeedDb() {
  const captured: {
    values?: unknown[];
    conflict?: { target: unknown; set: Record<string, unknown> };
  } = {};
  const onConflictDoUpdate = vi.fn().mockImplementation(async (arg) => {
    captured.conflict = arg;
  });
  const values = vi.fn().mockImplementation((rows: unknown[]) => {
    captured.values = rows;
    return { onConflictDoUpdate };
  });
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table !== schema.registrationWindows) throw new Error('unexpected insert target');
    return { values };
  });
  return { db: { insert } as never, captured, spies: { insert, values, onConflictDoUpdate } };
}

const SAMPLE: RegistrationWindowSeed = {
  municipality: 'markham',
  programDomain: 'rec_program',
  cycleLabel: 'Fall 2026',
  previewAt: '2026-08-02T06:30:00-04:00',
  residentOpenAt: null,
  openAt: '2026-08-11T06:30:00-04:00',
  residentPriorityDays: null,
  waitlistResponseHours: 48,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: 'https://www.markham.ca/example',
  verifiedAt: '2026-07-30T00:00:00Z',
  notes: null,
  publishedWeekdays: {},
};

describe('toRegistrationWindowRow', () => {
  it('parses a Toronto-local open time into the correct UTC instant (EDT, -04:00)', () => {
    const row = toRegistrationWindowRow(SAMPLE);
    // 6:30 a.m. on 11 Aug 2026 is EDT, so the instant is 10:30 UTC.
    expect(row.openAt).toEqual(new Date('2026-08-11T10:30:00.000Z'));
    expect(row.previewAt).toEqual(new Date('2026-08-02T10:30:00.000Z'));
  });

  it('rejects a wall-clock time with no offset rather than reading it in the server zone', () => {
    expect(() => toRegistrationWindowRow({ ...SAMPLE, openAt: '2026-08-11T06:30:00' })).toThrow(
      /explicit UTC offset/,
    );
  });

  it('rejects a non-https source so a row can never cite an unverifiable page', () => {
    expect(() =>
      toRegistrationWindowRow({ ...SAMPLE, sourceUrl: 'http://www.markham.ca/example' }),
    ).toThrow(/https/);
  });

  it('rejects a resident head start that lands after the general open', () => {
    expect(() =>
      toRegistrationWindowRow({
        ...SAMPLE,
        residentOpenAt: '2026-08-20T06:30:00-04:00',
        openAt: '2026-08-11T06:30:00-04:00',
      }),
    ).toThrow(/resident open/);
  });

  it('rejects an inverted age band', () => {
    expect(() =>
      toRegistrationWindowRow({ ...SAMPLE, ageMinMonths: 72, ageMaxMonths: 48 }),
    ).toThrow(/age band/);
  });

  it('accepts a resident open equal to the general open (no head start published)', () => {
    const row = toRegistrationWindowRow({
      ...SAMPLE,
      residentOpenAt: '2026-08-11T06:30:00-04:00',
    });
    expect(row.residentOpenAt).toEqual(row.openAt);
  });
});

describe('syncRegistrationWindows', () => {
  it('upserts on the natural key and refreshes every mutable field', async () => {
    const { db, captured, spies } = fakeSeedDb();

    const result = await syncRegistrationWindows(db, [SAMPLE]);

    expect(result).toEqual({ count: 1 });
    expect(captured.values).toEqual([toRegistrationWindowRow(SAMPLE)]);
    expect(captured.conflict?.target).toEqual([
      schema.registrationWindows.municipality,
      schema.registrationWindows.programDomain,
      schema.registrationWindows.cycleLabel,
    ]);
    // Dates move: a re-sync must be able to correct every field it seeded, and must
    // bump updated_at so the correction is visible.
    expect(Object.keys(captured.conflict?.set ?? {}).sort()).toEqual(
      [
        'ageMaxMonths',
        'ageMinMonths',
        'notes',
        'openAt',
        'previewAt',
        'residentOpenAt',
        'residentPriorityDays',
        'sourceUrl',
        'updatedAt',
        'verifiedAt',
        'waitlistResponseHours',
      ].sort(),
    );
    expect(spies.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: two runs issue the identical upsert', async () => {
    const first = fakeSeedDb();
    const second = fakeSeedDb();

    await syncRegistrationWindows(first.db, [SAMPLE]);
    await syncRegistrationWindows(second.db, [SAMPLE]);

    expect(second.captured.values).toEqual(first.captured.values);
    expect(second.captured.conflict?.target).toEqual(first.captured.conflict?.target);
  });

  it('is a no-op for an empty list (no insert issued)', async () => {
    const { db, spies } = fakeSeedDb();
    expect(await syncRegistrationWindows(db, [])).toEqual({ count: 0 });
    expect(spies.insert).not.toHaveBeenCalled();
  });
});

describe('the shipped verified list', () => {
  it('is non-empty and every entry builds a valid row', () => {
    expect(REGISTRATION_WINDOWS.length).toBeGreaterThan(0);
    for (const seed of REGISTRATION_WINDOWS) {
      expect(() => toRegistrationWindowRow(seed)).not.toThrow();
    }
  });

  it('has no duplicate natural keys (the seed would fight itself in one statement)', () => {
    const keys = REGISTRATION_WINDOWS.map(
      (s) => `${s.municipality}::${s.programDomain}::${s.cycleLabel}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cites the municipality it describes on every row', () => {
    // A Markham row must not be sourced from oakville.ca — the honesty anchor only
    // works if the URL belongs to the town whose dates it carries.
    const HOSTS: Record<string, string> = {
      toronto: 'toronto.ca',
      markham: 'markham.ca',
      vaughan: 'vaughan.ca',
      richmond_hill: 'richmondhill.ca',
      mississauga: 'mississauga.ca',
      oakville: 'oakville.ca',
      burlington: 'burlington.ca',
      halton_hills: 'haltonhills.ca',
      brampton: 'brampton.ca',
      caledon: 'caledon.ca',
      ajax: 'ajax.ca',
      pickering: 'pickering.ca',
      whitby: 'whitby.ca',
      oshawa: 'oshawa.ca',
      aurora: 'aurora.ca',
    };
    for (const seed of REGISTRATION_WINDOWS) {
      expect(new URL(seed.sourceUrl).hostname).toContain(HOSTS[seed.municipality]);
    }
  });

  it('never persists a seed-only field to the database row', () => {
    // publishedWeekdays is a build-time integrity guard, not data the app reads back.
    for (const seed of REGISTRATION_WINDOWS) {
      const row = toRegistrationWindowRow(seed) as Record<string, unknown>;
      expect(row.publishedWeekdays).toBeUndefined();
    }
  });

  it('agrees with the weekday its source printed — the stale-prior-year guard', () => {
    // Registration pages get carried forward a year at a time, and search engines serve
    // last year's dates for this year's query. A date/weekday mismatch is the cheapest
    // possible detector: "Monday, September 15" is 2025, never 2026.
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekdayInToronto = (instant: Date): string =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        weekday: 'long',
      }).format(instant);

    let checked = 0;
    for (const seed of REGISTRATION_WINDOWS) {
      for (const [field, published] of Object.entries(seed.publishedWeekdays)) {
        const value = seed[field as 'previewAt' | 'residentOpenAt' | 'openAt'];
        if (!value) throw new Error(`${seed.cycleLabel}: weekday given for an absent ${field}`);
        expect(WEEKDAYS).toContain(published);
        expect(
          `${seed.municipality}/${seed.cycleLabel}/${field}: ${weekdayInToronto(new Date(value))}`,
        ).toBe(`${seed.municipality}/${seed.cycleLabel}/${field}: ${published}`);
        checked += 1;
      }
    }
    // Guard the guard: if the seed loses its weekday annotations this test would pass
    // vacuously while checking nothing.
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('records every local time with the offset America/Toronto actually had that day', () => {
    // The DST trap: a hand-typed -04:00 on a November date is an hour wrong. This
    // derives the true offset from the IANA zone and compares.
    const offsetAt = (instant: Date): string => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Toronto',
        timeZoneName: 'longOffset',
      }).formatToParts(instant);
      const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      return name.replace('GMT', '');
    };
    for (const seed of REGISTRATION_WINDOWS) {
      for (const [field, value] of [
        ['openAt', seed.openAt],
        ['residentOpenAt', seed.residentOpenAt],
        ['previewAt', seed.previewAt],
      ] as const) {
        if (!value) continue;
        const declared = value.slice(-6);
        if (declared === 'Z' || !/^[+-]\d{2}:\d{2}$/.test(declared)) continue;
        expect(
          `${seed.municipality}/${seed.programDomain}/${seed.cycleLabel} ${field} ${declared}`,
        ).toBe(
          `${seed.municipality}/${seed.programDomain}/${seed.cycleLabel} ${field} ${offsetAt(new Date(value))}`,
        );
      }
    }
  });
});
