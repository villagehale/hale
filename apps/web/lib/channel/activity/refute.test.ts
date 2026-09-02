import { describe, expect, it } from 'vitest';
import { MIN_QUOTE_CHARS, refuteSlots } from './refute';
import type { SynthesisRow } from './synthesis';

/**
 * THE ADVERSARIAL PASS, tested as the thing that DROPS rather than the thing that keeps.
 *
 * Every case here is a slot a synthesis could plausibly return and a parent could
 * plausibly act on. The gate's whole job is that none of them reaches a phone, and each
 * assertion below is paired with a positive control through the same call — an absence
 * assertion with nothing proving the path was live is an assertion that fails open.
 */

const VENUE = 'https://cartwheelsgymcentre.example/programs';
const TOWN = 'https://haltonhills.example/recreation/swim';

const PAGES = [
  {
    url: VENUE,
    text: 'Fall block runs Sept 14 to Oct 26.\nTiny Gym  Sundays 9:30-10:15   $124 per term.\nRegistration has been open since July 22.',
  },
  {
    url: TOWN,
    text: 'Parent and Tot 1 | Mon | 10:00AM - 10:30AM | Oct 05 - Dec 07 | $86.22 for nine lessons',
  },
];

/** A row every gate passes — the positive control every negative case is run beside. */
function backedRow(overrides: Partial<SynthesisRow> = {}): SynthesisRow {
  return {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    age_fit: 'walking to 3.5 years',
    when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
    when_quote: 'Tiny Gym Sundays 9:30-10:15',
    price: '$124 per term',
    price_quote: '$124 per term',
    registration: 'Open since July 22',
    registration_quote: 'Registration has been open since July 22',
    source_name: 'Cartwheels Gym Centre',
    source_url: VENUE,
    ...overrides,
  };
}

describe('refuteSlots', () => {
  it('keeps a row whose every fact is quoted off the page it cites', () => {
    const result = refuteSlots([backedRow()], PAGES);

    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({
      name: 'Tiny Gym, Cartwheels Gym Centre',
      when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
      price: '$124 per term',
      registration: 'Open since July 22',
      sourceUrl: VENUE,
      source: 'web',
    });
    expect(result.slotsRefused).toBe(0);
    expect(result.factsRefused).toBe(0);
  });

  it('drops a row citing a page no leg opened, and counts it', () => {
    const poisoned = backedRow({ source_url: 'https://invented-source.example/schedule' });

    const result = refuteSlots([poisoned, backedRow()], PAGES);

    expect(result.slots.map((slot) => slot.sourceUrl)).toEqual([VENUE]);
    expect(result.slotsRefused).toBe(1);
    expect(result.slotReasons.uncited_page).toBe(1);
  });

  it('KEEPS a fact quoted off another page when the fact names that page - the merge', () => {
    // The whole reason the fan-out exists: the schedule is on the venue's grid and the
    // fee is in the town's table, and one slot carries both.
    const merged = backedRow({
      price: '$86.22 for nine lessons',
      price_quote: '$86.22 for nine lessons',
      price_source: TOWN,
    });

    const result = refuteSlots([merged], PAGES);

    expect(result.slots[0]?.price).toBe('$86.22 for nine lessons');
    expect(result.factsRefused).toBe(0);
  });

  it('drops a fact that names a page NO leg opened', () => {
    const offPage = backedRow({
      price: '$310 per term',
      price_quote: 'Tiny Gym term fee $310',
      price_source: 'https://invented.example/fees',
    });

    const result = refuteSlots([offPage], PAGES);

    expect(result.slots[0]?.price).toBeNull();
    expect(result.factReasons.source_not_read).toBe(1);
  });

  it('drops a fact whose quote is on a DIFFERENT page than the one the row cites', () => {
    // The $86.22 is real and is on the municipal page. This row cites the gym.
    const crossed = backedRow({ price: '$86.22 for nine lessons', price_quote: '$86.22 for nine lessons' });

    const result = refuteSlots([crossed], PAGES);

    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]?.price).toBeNull();
    // The two facts that WERE on the cited page survive - the drop is per fact.
    expect(result.slots[0]?.when).toBe('Sundays 9:30-10:15, Sept 14 to Oct 26');
    expect(result.factsRefused).toBe(1);
    expect(result.factReasons.quote_absent).toBe(1);
  });

  it('drops a fact the model asserted with no quote at all', () => {
    const unquoted = backedRow({ price: '$310 per term', price_quote: null });

    const result = refuteSlots([unquoted], PAGES);

    expect(result.slots[0]?.price).toBeNull();
    expect(result.slots[0]?.registration).toBe('Open since July 22');
    expect(result.factReasons.no_quote).toBe(1);
  });

  it('drops a fact whose quote is too short to identify anything', () => {
    const trivial = backedRow({ price: '$99', price_quote: '$' });
    expect('$'.length).toBeLessThan(MIN_QUOTE_CHARS);

    const result = refuteSlots([trivial], PAGES);

    expect(result.slots[0]?.price).toBeNull();
    expect(result.factReasons.quote_too_short).toBe(1);
  });

  it('drops the whole row when no schedule fact survives', () => {
    const hollow = backedRow({
      when: 'Fall session',
      when_quote: 'a sentence that is nowhere on that page',
      price: null,
      price_quote: null,
      registration: null,
      registration_quote: null,
    });

    const result = refuteSlots([hollow, backedRow()], PAGES);

    expect(result.slots).toHaveLength(1);
    expect(result.slotReasons.no_backed_fact).toBe(1);
  });

  it('matches a quote across whitespace and typographic punctuation the page renders differently', () => {
    const reflowed = backedRow({
      when_quote: 'Tiny  Gym\n Sundays 9:30–10:15',
      registration_quote: 'Registration has been open since July 22',
    });

    const result = refuteSlots([reflowed], PAGES);

    expect(result.slots[0]?.when).toBe('Sundays 9:30-10:15, Sept 14 to Oct 26');
    expect(result.factsRefused).toBe(0);
  });

  it('matches the cited page across a trailing slash, a fragment and a www host', () => {
    const sloppy = backedRow({
      source_url: 'https://www.cartwheelsgymcentre.example/programs/#fall',
    });

    const result = refuteSlots([sloppy], PAGES);

    expect(result.slots).toHaveLength(1);
    expect(result.slotsRefused).toBe(0);
  });

  it('drops a row whose citation is not an absolute url', () => {
    const result = refuteSlots([backedRow({ source_url: 'programs.php' }), backedRow()], PAGES);

    expect(result.slots).toHaveLength(1);
    expect(result.slotReasons.bad_citation).toBe(1);
  });

  it('drops a row missing the fields that say what it even is', () => {
    const result = refuteSlots([backedRow({ age_fit: '  ' }), backedRow()], PAGES);

    expect(result.slots).toHaveLength(1);
    expect(result.slotReasons.incomplete_row).toBe(1);
  });

  it('refuses every row when no page was opened at all', () => {
    const result = refuteSlots([backedRow()], []);

    expect(result.slots).toEqual([]);
    expect(result.slotsRefused).toBe(1);
  });
});
