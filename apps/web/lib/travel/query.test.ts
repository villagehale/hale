import { describe, expect, it } from 'vitest';
import { MAX_QUERY_FIELD_CHARS, travelQueryFor } from '~/lib/channel/activity/deidentify';
import { TRAVEL_SUBJECT, travelDestination, travelWindow } from './query';

/**
 * THE SCRUB TEST, and it is the one that fails open if it is not written.
 *
 * `scrubResidualPii` runs inside `gateFreeText` on every field on the way to the search,
 * and it replaces ISO dates, `M/D/YYYY`, `Month D, YYYY` and a bare `N years`. Nothing
 * errors when it fires: the query simply goes out as "things to do in New York [redacted]
 * to [redacted]" and the search quietly loses its dates. Every other test in this feature
 * would still pass.
 *
 * So each assertion that a composed string SURVIVES is paired with the form that does
 * NOT, in the same `it`. Without that pair, a gate that had stopped scrubbing anything at
 * all would make the survival assertions pass for the wrong reason.
 */

const HOUSEHOLD = ['Mia', 'Leo', 'Sarah'];

function gated(input: { subject?: string; window?: string; destination?: string }) {
  return travelQueryFor({
    subject: input.subject ?? TRAVEL_SUBJECT,
    window: input.window ?? travelWindow('2026-09-12', '2026-09-15'),
    destination: input.destination ?? travelDestination('New York', 'NY'),
    stage: 'preschool',
    householdNames: HOUSEHOLD,
  });
}

describe('travelWindow', () => {
  it('says the month once inside one month, and twice across a boundary', () => {
    expect(travelWindow('2026-09-12', '2026-09-15')).toBe('September 12 to 15');
    expect(travelWindow('2026-08-30', '2026-09-02')).toBe('August 30 to September 2');
    expect(travelWindow('2026-09-12', '2026-09-12')).toBe('September 12');
  });

  it('carries NO year, in any form', () => {
    for (const window of [
      travelWindow('2026-09-12', '2026-09-15'),
      travelWindow('2026-12-30', '2027-01-03'),
    ]) {
      expect(window, window).not.toMatch(/\d{4}/);
    }
  });
});

describe('the composed query survives the scrub, and the ISO form does not', () => {
  it('carries the window through gateFreeText byte for byte', () => {
    const composed = travelWindow('2026-09-12', '2026-09-15');
    const result = gated({ window: composed });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.window).toBe(composed);
    expect(result.query.window).toBe('September 12 to 15');

    // THE POSITIVE CONTROL. The same field, written the way a maker reaching for the
    // stored columns would write it, comes back redacted — which is what makes the
    // assertion above a claim about the composer rather than about a scrub that is off.
    const iso = gated({ window: '2026-09-12 to 2026-09-15' });
    expect(iso.ok).toBe(true);
    if (!iso.ok) return;
    expect(iso.query.window).toContain('[redacted]');
    expect(iso.query.window).not.toContain('2026');
  });

  it('carries the subject through unchanged, and an age word would not survive', () => {
    const result = gated({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.subject).toBe(TRAVEL_SUBJECT);
    expect(TRAVEL_SUBJECT.length).toBeLessThanOrEqual(MAX_QUERY_FIELD_CHARS);
    expect(TRAVEL_SUBJECT).not.toMatch(/\d/);

    // The positive control, and the reason the age band rides on `stage`: a subject that
    // named the age would lose it silently.
    const aged = gated({ subject: 'things to do with a 3 year old on a short visit' });
    expect(aged.ok).toBe(true);
    if (!aged.ok) return;
    expect(aged.query.subject).toContain('[redacted]');
  });

  it('carries the destination through, comma and all', () => {
    const result = gated({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The comma is CODE'S, composed from two columns. `destinationShape` refuses one in
    // either column at the parse boundary, so this is the only place one can appear.
    expect(result.query.town).toBe('New York, NY');
    expect(travelDestination('Ottawa', null)).toBe('Ottawa');
    expect(travelDestination('Ottawa', '  ')).toBe('Ottawa');
  });

  it('puts the age band on `stage` and nowhere else', () => {
    const result = gated({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.stage).toBe('preschool');
    // There is no field on ActivityQuery that could hold a name, an age or an address —
    // asserted over the whole serialised query rather than a field list.
    const serialised = JSON.stringify(result.query);
    for (const name of HOUSEHOLD) expect(serialised).not.toContain(name);
  });
});

describe('travelQueryFor refuses rather than sending half a query', () => {
  /**
   * A child called Paris and a trip to Paris. It is refused HERE as well as at the parse
   * boundary, because the household can change between the detection and the send — a
   * child added this morning is a name that must not cross the border this afternoon.
   */
  it('refuses a destination that names a member of this household', () => {
    const result = travelQueryFor({
      subject: TRAVEL_SUBJECT,
      window: 'September 12 to 15',
      destination: 'Paris, France',
      stage: 'preschool',
      householdNames: ['Paris'],
    });
    expect(result).toEqual({ ok: false, refusal: 'names_a_person' });

    // The positive control: the same destination for a household with no Paris in it.
    const other = travelQueryFor({
      subject: TRAVEL_SUBJECT,
      window: 'September 12 to 15',
      destination: 'Paris, France',
      stage: 'preschool',
      householdNames: ['Mia'],
    });
    expect(other.ok).toBe(true);
  });

  it('refuses an over-long window rather than truncating it', () => {
    const result = gated({ window: 'September '.repeat(20) });
    expect(result).toEqual({ ok: false, refusal: 'window_too_long' });
  });
});
