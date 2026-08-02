import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  corroborateSlot,
  parseHoursStrict,
  supportedDays,
  timeTokenMinutes,
} from './hours-text';

/**
 * VIL-252 · M16 · Tier ② — the deterministic half of EarlyON schedule parsing,
 * against the City of Toronto's own published hours strings.
 *
 * Every expected time below is transcribed from the fixture's source text by
 * reading it, not from what the parser returns. `noon` is the case that matters
 * most: it is the single most common way these records express 12:00, and a
 * parser that reads it as midnight sends a parent to a closed building at the
 * wrong end of the day.
 */

const centres = () =>
  JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'earlyon-toronto-centres.json'), 'utf8'),
  ) as { result: { records: Array<{ loc_id: number; dropinHours: string | null }> } };

const dropinFor = (locId: number): string => {
  const record = centres().result.records.find((r) => r.loc_id === locId);
  if (!record?.dropinHours) throw new Error(`fixture ${locId} has no dropinHours`);
  return record.dropinHours;
};

describe('timeTokenMinutes', () => {
  it('reads noon as midday, not midnight', () => {
    expect(timeTokenMinutes('noon')).toBe(12 * 60);
  });

  it('reads midnight as zero', () => {
    expect(timeTokenMinutes('midnight')).toBe(0);
  });

  it('reads the municipal a.m./p.m. spelling', () => {
    expect(timeTokenMinutes('9:00 a.m.')).toBe(9 * 60);
    expect(timeTokenMinutes('12:30 p.m.')).toBe(12 * 60 + 30);
    expect(timeTokenMinutes('4:30 p.m.')).toBe(16 * 60 + 30);
    expect(timeTokenMinutes('7:30 a.m.')).toBe(7 * 60 + 30);
  });

  it('keeps 12 a.m./p.m. on the right side of midday', () => {
    expect(timeTokenMinutes('12:00 a.m.')).toBe(0);
    expect(timeTokenMinutes('12:00 p.m.')).toBe(12 * 60);
  });

  it('refuses a bare time with no meridiem rather than guessing', () => {
    expect(timeTokenMinutes('9:30')).toBeNull();
  });
});

describe('parseHoursStrict — real City of Toronto records', () => {
  it('parses a single-day, single-range centre', () => {
    // 13650: "Wednesday: 9:00 a.m. - 11:30 a.m."
    expect(parseHoursStrict(dropinFor(13650))).toEqual([
      { dayOfWeek: 3, startMinute: 9 * 60, endMinute: 11 * 60 + 30 },
    ]);
  });

  it('parses two ranges in one day', () => {
    // 13423: "Monday: 9:30 a.m. - 11:30 a.m.  ; 1:30 p.m. - 3:30 p.m."
    expect(parseHoursStrict(dropinFor(13423))).toEqual([
      { dayOfWeek: 1, startMinute: 9 * 60 + 30, endMinute: 11 * 60 + 30 },
      { dayOfWeek: 1, startMinute: 13 * 60 + 30, endMinute: 15 * 60 + 30 },
    ]);
  });

  it('reads `noon` as an END time in a real multi-day record', () => {
    // 12562 Monday: "10:00 a.m. - noon  ; 3:30 p.m. - 6:00 p.m."
    const slots = parseHoursStrict(dropinFor(12562));
    const monday = slots?.filter((s) => s.dayOfWeek === 1);
    expect(monday).toEqual([
      { dayOfWeek: 1, startMinute: 10 * 60, endMinute: 12 * 60 },
      { dayOfWeek: 1, startMinute: 15 * 60 + 30, endMinute: 18 * 60 },
    ]);
  });

  it('reads `noon` as a START time', () => {
    // 13958 Monday: "noon - 3:00 p.m.  ; 4:00 p.m. - 8:00 p.m."
    const monday = parseHoursStrict(dropinFor(13958))?.filter((s) => s.dayOfWeek === 1);
    expect(monday?.[0]).toEqual({ dayOfWeek: 1, startMinute: 12 * 60, endMinute: 15 * 60 });
  });

  it('collapses the ranges upstream repeats verbatim', () => {
    // 13958 Wednesday lists "9:30 a.m. - 3:00 p.m." and "4:00 p.m. - 8:00 p.m."
    // TWICE each in the source. A duplicate is an upstream artefact, not two
    // sessions — surfacing it twice would read as two different drop-ins.
    const wednesday = parseHoursStrict(dropinFor(13958))?.filter((s) => s.dayOfWeek === 3);
    expect(wednesday).toEqual([
      { dayOfWeek: 3, startMinute: 9 * 60 + 30, endMinute: 15 * 60 },
      { dayOfWeek: 3, startMinute: 16 * 60, endMinute: 20 * 60 },
    ]);
  });

  it('parses every day of a six-day record with the right day numbers', () => {
    // 12549 Abiona runs Monday–Saturday.
    const slots = parseHoursStrict(dropinFor(12549));
    expect([...new Set(slots?.map((s) => s.dayOfWeek))].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    // Saturday: "9:00 a.m. - noon"
    expect(slots?.filter((s) => s.dayOfWeek === 6)).toEqual([
      { dayOfWeek: 6, startMinute: 9 * 60, endMinute: 12 * 60 },
    ]);
  });

  it('returns null on text it cannot fully account for, rather than a partial read', () => {
    // A half-understood schedule is the dangerous outcome: it looks complete.
    expect(parseHoursStrict('Mondays in the fall, mornings — call ahead')).toBeNull();
    expect(parseHoursStrict('Monday: 9:00 a.m. - 11:30 a.m. | Tuesday: by appointment')).toBeNull();
    expect(parseHoursStrict('')).toBeNull();
  });

  it('rejects a range that ends before it starts', () => {
    expect(parseHoursStrict('Monday: 3:00 p.m. - 9:00 a.m.')).toBeNull();
  });
});

describe('corroborateSlot — the anti-fabrication gate', () => {
  const source = dropinFor(12562);

  it('accepts a slot whose day and both times are an adjacent pair in the source', () => {
    expect(
      corroborateSlot(source, { dayOfWeek: 1, startMinute: 10 * 60, endMinute: 12 * 60 }),
    ).toBe('exact');
  });

  it('REJECTS a plausible time that is simply not in the source', () => {
    // 11:00 a.m. appears nowhere in this record. A model that offers it is
    // inventing, and an invented time must never reach a parent.
    expect(
      corroborateSlot(source, { dayOfWeek: 1, startMinute: 11 * 60, endMinute: 12 * 60 }),
    ).toBe('none');
  });

  it('REJECTS times that exist in the day but were never paired with each other', () => {
    // Monday really does contain 10:00 a.m. and 6:00 p.m. — but as the start of
    // one range and the end of another. Reading them as one 8-hour drop-in is the
    // subtle failure a token-presence check alone would wave through.
    expect(
      corroborateSlot(source, { dayOfWeek: 1, startMinute: 10 * 60, endMinute: 18 * 60 }),
    ).toBe('none');
  });

  it('REJECTS a pair borrowed from a different day', () => {
    // Tuesday's real range is 2:00-4:00 p.m.; Monday's 3:30-6:00 p.m. is not Tuesday's.
    expect(
      corroborateSlot(source, { dayOfWeek: 2, startMinute: 15 * 60 + 30, endMinute: 18 * 60 }),
    ).toBe('none');
  });

  it('REJECTS a day the source never mentions', () => {
    expect(
      corroborateSlot(source, { dayOfWeek: 0, startMinute: 10 * 60, endMinute: 12 * 60 }),
    ).toBe('none');
  });

  it('REJECTS a span merged from the first start and the last end', () => {
    // Both times are real Monday tokens, but the centre closes at 10 and reopens
    // at 11 — "9:00 to noon" would send a parent to a locked door at 10:15.
    expect(
      corroborateSlot('Monday: 9:00 a.m. - 10:00 a.m.  ; 11:00 a.m. - noon', {
        dayOfWeek: 1,
        startMinute: 9 * 60,
        endMinute: 12 * 60,
      }),
    ).toBe('none');
  });

  // Verbatim from Applegrove Community Complex's EarlyON page — the shape real
  // centre webpages use, and the reason the corroborator cannot assume the
  // municipal "Day: ranges" format.
  const PROSE = 'Monday to Thursday 9:00 am — 2:00 pm Year-round';

  it('vouches for the days inside a written-out day range', () => {
    expect([...supportedDays(PROSE)].sort()).toEqual([1, 2, 3, 4]);
  });

  it('corroborates a mid-range day the text never names outright', () => {
    // Wednesday is covered by "Monday to Thursday" — rejecting it would empty
    // the fallback path on exactly the text the fallback exists for.
    expect(
      corroborateSlot(PROSE, { dayOfWeek: 3, startMinute: 9 * 60, endMinute: 14 * 60 }),
    ).toBe('exact');
  });

  it('still rejects a day outside the written range', () => {
    expect(
      corroborateSlot(PROSE, { dayOfWeek: 6, startMinute: 9 * 60, endMinute: 14 * 60 }),
    ).toBe('none');
  });

  it('still rejects an invented time inside a vouched-for day range', () => {
    expect(
      corroborateSlot(PROSE, { dayOfWeek: 2, startMinute: 9 * 60, endMinute: 15 * 60 }),
    ).toBe('none');
  });

  it('handles a comma-and-ampersand day list with no-space times', () => {
    // Also verbatim from Applegrove's second location.
    const listed = 'Thursday, Friday & Saturday 9:30am — 1:00pm';
    expect([...supportedDays(listed)].sort()).toEqual([4, 5, 6]);
    expect(
      corroborateSlot(listed, { dayOfWeek: 5, startMinute: 9 * 60 + 30, endMinute: 13 * 60 }),
    ).toBe('exact');
  });

  it('accepts each real range of a multi-range day on its own', () => {
    const source = 'Monday: 9:00 a.m. - 10:00 a.m.  ; 11:00 a.m. - noon';
    expect(
      corroborateSlot(source, { dayOfWeek: 1, startMinute: 9 * 60, endMinute: 10 * 60 }),
    ).toBe('exact');
    expect(
      corroborateSlot(source, { dayOfWeek: 1, startMinute: 11 * 60, endMinute: 12 * 60 }),
    ).toBe('exact');
  });
});
