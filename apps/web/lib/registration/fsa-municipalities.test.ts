import type { Municipality } from '@hale/db';
import { describe, expect, it } from 'vitest';
import {
  FSA_MUNICIPALITIES,
  districtForFsa,
  fsasForMunicipality,
  municipalitiesForFsa,
} from './fsa-municipalities';
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

  it('resolves L4A to Whitchurch-Stouffville, which the source files under Stouffville', () => {
    // Same community-name trap as Georgetown, and L4's second character is no help:
    // L4A is Stouffville while L4B is Richmond Hill and L4G is Aurora.
    expect(municipalitiesForFsa('L4A')).toEqual(['whitchurch_stouffville']);
  });

  it('resolves the York codes the source files under a community, not the town', () => {
    // Same trap again, four times over: searching "King", "Georgina" or "East
    // Gwillimbury" in the L table finds L7B, L4P and L9N under King City, Keswick and
    // Holland Landing instead. L4's second character is no help - L4A is Stouffville,
    // L4G is Aurora and L4P is Georgina.
    expect(municipalitiesForFsa('L7B')).toEqual(['king']);
    expect(municipalitiesForFsa('L4P')).toEqual(['georgina']);
    expect(municipalitiesForFsa('L9N')).toEqual(['east_gwillimbury']);
    expect(municipalitiesForFsa('L9P')).toEqual(['uxbridge']);
  });

  it('leaves the three rural codes these towns share resolving to nothing', () => {
    // The likeliest wrong extension of this table: L0G looks like King's code because
    // Nobleton, Schomberg and Kettleby are printed in it - but so are East
    // Gwillimbury's villages, Richmond Hill's Oak Ridges, and Bradford, Beeton and
    // Loretto, which are three towns Hale holds no dates for. Adding it would hand a
    // Bradford family King's registration mornings.
    expect(municipalitiesForFsa('L0G')).toEqual([]);
    expect(municipalitiesForFsa('L0E')).toEqual([]); // Georgina + Uxbridge + Brock
    expect(municipalitiesForFsa('L0C')).toEqual([]); // Uxbridge + Scugog + Brock
  });

  it('keeps L7A in Brampton - its neighbour Mayfield West is the Caledon side', () => {
    expect(municipalitiesForFsa('L7A')).toEqual(['brampton']);
    expect(municipalitiesForFsa('L7C')).toEqual(['caledon']);
  });
});

describe('districtForFsa', () => {
  it('resolves the Fall 2026 mornings by neighbourhood, not by the second letter', () => {
    expect(districtForFsa('M2N')).toBe('north_york');
    expect(districtForFsa('M1B')).toBe('scarborough');
    expect(districtForFsa('M8V')).toBe('etobicoke_york');
    expect(districtForFsa('M5V')).toBe('toronto_east_york');
    // Exceptions to the second-letter guess: North York islands in M4/M5/M6/M9,
    // and York sitting with Etobicoke.
    expect(districtForFsa('M4A')).toBe('north_york');
    expect(districtForFsa('M5M')).toBe('north_york');
    expect(districtForFsa('M6A')).toBe('north_york');
    expect(districtForFsa('M6B')).toBe('north_york');
    expect(districtForFsa('M6L')).toBe('north_york');
    expect(districtForFsa('M9L')).toBe('north_york');
    expect(districtForFsa('M9M')).toBe('north_york');
    expect(districtForFsa('M6C')).toBe('etobicoke_york');
    expect(districtForFsa('M9N')).toBe('etobicoke_york');
    expect(districtForFsa('M4B')).toBe('toronto_east_york');
    // Not a Toronto neighbourhood, a facility, or an unassigned code.
    expect(districtForFsa('L3R')).toBeNull();
    expect(districtForFsa('M7R')).toBeNull();
    expect(districtForFsa('M1A')).toBeNull();
  });

  it('only names a district for an FSA the municipality rule already calls Toronto', () => {
    for (const fsa of ['M2N', 'M1B', 'M8V', 'M5V', 'M4A', 'M6A', 'M9L', 'M9N', 'M4B', 'M6S']) {
      expect(municipalitiesForFsa(fsa), fsa).toEqual(['toronto']);
      expect(districtForFsa(fsa), fsa).not.toBeNull();
    }
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

  it('gives Whitchurch-Stouffville its single FSA', () => {
    expect(fsasForMunicipality('whitchurch_stouffville')).toEqual(['L4A']);
  });

  it('gives Newmarket both halves of the town, sorted', () => {
    expect(fsasForMunicipality('newmarket')).toEqual(['L3X', 'L3Y']);
  });

  it('gives each new York town exactly the one urban FSA it has', () => {
    // One code each, and the rural rest of the township is deliberately absent: this
    // is the coverage hole named in limit 2, not a table that lost an entry.
    expect(fsasForMunicipality('king')).toEqual(['L7B']);
    expect(fsasForMunicipality('east_gwillimbury')).toEqual(['L9N']);
    expect(fsasForMunicipality('georgina')).toEqual(['L4P']);
    expect(fsasForMunicipality('uxbridge')).toEqual(['L9P']);
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
