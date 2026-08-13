import type { Municipality } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { FSA_MUNICIPALITIES, fsasForMunicipality, municipalitiesForFsa } from './fsa-municipalities';
import { REGISTRATION_WINDOWS } from './registration-windows-data';

/**
 * The table is data, so the tests are the SHAPE of the data, not a second copy of it —
 * re-typing every FSA here would only prove the two lists were typed by the same hand.
 * What is checked is what a wrong entry would break: the round trip, the confidence
 * rule, and the two Toronto rules the whole feature rests on.
 */

describe('municipalitiesForFsa', () => {
  it('resolves the whole M range to Toronto by rule, not by enumeration', () => {
    // The rule is the point: an enumerated M list was missing four real FSAs.
    for (const fsa of ['M4K', 'M5V', 'M1B', 'M9W', 'M6H']) {
      expect(municipalitiesForFsa(fsa)).toEqual(['toronto']);
    }
  });

  it('resolves the two M facility codes to nothing - nobody lives at either', () => {
    expect(municipalitiesForFsa('M7R')).toEqual([]);
    expect(municipalitiesForFsa('M0R')).toEqual([]);
  });

  it('resolves nothing for an FSA outside the covered set', () => {
    expect(municipalitiesForFsa('K1A')).toEqual([]); // Ottawa
    expect(municipalitiesForFsa('L9T')).toEqual([]); // Milton - not a seeded municipality
    expect(municipalitiesForFsa('L0P')).toEqual([]); // rural, five municipalities
  });

  it('records a boundary-straddling FSA as both towns rather than the likelier one', () => {
    expect(municipalitiesForFsa('L3T')).toHaveLength(2);
    expect([...municipalitiesForFsa('L3T')].sort()).toEqual(['markham', 'vaughan']);
  });

  it('covers the towns Wikipedia files under a community name, not the town name', () => {
    // The trap for the next person extending this: searching "Halton Hills" or "Caledon"
    // in the source finds neither of these.
    expect(municipalitiesForFsa('L7G')).toEqual(['halton_hills']); // Georgetown
    expect(municipalitiesForFsa('L7J')).toEqual(['halton_hills']); // Acton
    expect(municipalitiesForFsa('L7E')).toEqual(['caledon']); // Bolton
  });

  it('keeps L7A in Brampton - its neighbour Mayfield West is the Caledon side', () => {
    expect(municipalitiesForFsa('L7A')).toEqual(['brampton']);
    expect(municipalitiesForFsa('L7C')).toEqual(['caledon']);
  });
});

describe('fsasForMunicipality', () => {
  it('round-trips every unambiguous entry: an FSA is in its own municipality list', () => {
    // The invariant the intros anchor radius rests on — a family's own FSA is always
    // inside the area they were matched across, so the radius can only ever widen.
    for (const [fsa, municipalities] of Object.entries(FSA_MUNICIPALITIES)) {
      if (municipalities.length !== 1) continue;
      expect(fsasForMunicipality(municipalities[0] as Municipality)).toContain(fsa);
    }
  });

  it('leaves a straddling FSA out of both towns lists', () => {
    expect(fsasForMunicipality('markham')).not.toContain('L3T');
    expect(fsasForMunicipality('vaughan')).not.toContain('L3T');
    expect(fsasForMunicipality('markham')).not.toContain('L4J');
  });

  it('returns nothing for Toronto, because the M range is a rule and not a list', () => {
    expect(fsasForMunicipality('toronto')).toEqual([]);
  });

  it('gives Halton Hills exactly Georgetown and Acton', () => {
    expect(fsasForMunicipality('halton_hills')).toEqual(['L7G', 'L7J']);
  });

  it('gives Aurora its single FSA', () => {
    expect(fsasForMunicipality('aurora')).toEqual(['L4G']);
  });

  it('is sorted, so a radius is stable across runs', () => {
    const oshawa = fsasForMunicipality('oshawa');
    expect(oshawa).toEqual([...oshawa].sort());
    expect(oshawa.length).toBeGreaterThan(1);
  });
});

describe('coverage against the seeded registration windows', () => {
  it('maps every municipality that has a registration window on file', () => {
    // A seeded municipality with no FSAs is a town Hale holds dates for and can never
    // match a family to — the coverage hole this table exists to close.
    const seeded = new Set(REGISTRATION_WINDOWS.map((w) => w.municipality));
    const unmapped = [...seeded]
      .filter((m) => m !== 'toronto')
      .filter((m) => fsasForMunicipality(m).length === 0);
    expect(unmapped).toEqual([]);
  });
});
