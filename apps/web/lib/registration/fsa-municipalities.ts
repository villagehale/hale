import type { Municipality } from '@hale/db';

/**
 * VIL-236 · M1 — Forward Sortation Area (the first three characters of a postal code)
 * to municipality, for the eight GTA towns the registration radar covers.
 *
 * COVERAGE LIMITS, deliberately chosen and worth reading before extending this:
 *
 * 1. Toronto is a RULE, not a list. Canada Post assigns the entire M range to the City
 *    of Toronto with two non-residential exceptions (M7R and M0R are Canada Post
 *    facilities in Mississauga). An enumerated M list is easy to get subtly wrong —
 *    ours was missing four real Toronto FSAs on the first pass — so the rule is safer.
 *
 * 2. Rural L0* FSAs are EXCLUDED entirely. Each one spans four to six municipalities
 *    (L0P covers Halton Hills, Milton, Burlington, Caledon and Brampton; L0G covers
 *    Richmond Hill plus five York/Simcoe towns), most of them outside our coverage.
 *    Serving a Milton family Halton Hills dates is worse than serving them nothing, so
 *    they resolve to nothing. This is the main known coverage hole.
 *
 * 3. Two Thornhill FSAs genuinely straddle a municipal boundary and are recorded as
 *    spanning both towns. Yonge Street is the line, but postal walks are not published
 *    at parcel level, so neither can be attributed with confidence. The matcher's
 *    response is to decline to claim residency rather than pick the likelier town.
 *
 * 4. The FSA's second character does NOT group by municipality — L4 alone spans
 *    Richmond Hill, Vaughan, Mississauga, Barrie, Keswick, Midland, Stouffville and
 *    Aurora. Any prefix-range shortcut here would be a bug; the table is explicit.
 *
 * Sources: Canada Post's published FSA assignments as tabulated in
 * https://en.wikipedia.org/wiki/List_of_postal_codes_of_Canada:_L and
 * https://en.wikipedia.org/wiki/List_of_postal_codes_of_Canada:_M, spot-corroborated
 * against GeoNames for the disputed Thornhill codes. Verified 2026-07-30.
 */
export const FSA_MUNICIPALITIES: Readonly<Record<string, readonly Municipality[]>> = {
  // ── Markham ──
  L3P: ['markham'],
  L3R: ['markham'],
  L3S: ['markham'],
  L6B: ['markham'],
  L6C: ['markham'],
  L6E: ['markham'],
  L6G: ['markham'],

  // ── Vaughan ──
  L3L: ['vaughan'],
  L4H: ['vaughan'],
  L4K: ['vaughan'],
  L4L: ['vaughan'],
  L6A: ['vaughan'],

  // ── Thornhill: genuinely split on Yonge Street, so both towns, neither claimed ──
  L3T: ['markham', 'vaughan'],
  L4J: ['vaughan', 'markham'],

  // ── Richmond Hill ──
  L4B: ['richmond_hill'],
  L4C: ['richmond_hill'],
  L4E: ['richmond_hill'],
  L4S: ['richmond_hill'],

  // ── Mississauga ──
  L4T: ['mississauga'],
  L4V: ['mississauga'],
  L4W: ['mississauga'],
  L4X: ['mississauga'],
  L4Y: ['mississauga'],
  L4Z: ['mississauga'],
  L5A: ['mississauga'],
  L5B: ['mississauga'],
  L5C: ['mississauga'],
  L5E: ['mississauga'],
  L5G: ['mississauga'],
  L5H: ['mississauga'],
  L5J: ['mississauga'],
  L5K: ['mississauga'],
  L5L: ['mississauga'],
  L5M: ['mississauga'],
  L5N: ['mississauga'],
  L5P: ['mississauga'],
  L5R: ['mississauga'],
  L5S: ['mississauga'],
  L5T: ['mississauga'],
  L5V: ['mississauga'],
  L5W: ['mississauga'],

  // ── Oakville ──
  L6H: ['oakville'],
  L6J: ['oakville'],
  L6K: ['oakville'],
  L6L: ['oakville'],
  L6M: ['oakville'],

  // ── Burlington ──
  L7L: ['burlington'],
  L7M: ['burlington'],
  L7N: ['burlington'],
  L7P: ['burlington'],
  L7R: ['burlington'],
  L7S: ['burlington'],
  L7T: ['burlington'],

  // ── Halton Hills ──
  L7G: ['halton_hills'],
  L7J: ['halton_hills'],
};

/** The two M FSAs that are Canada Post facilities in Mississauga, not Toronto. Nobody
 * lives at either, so they resolve to nothing rather than to a town. */
const NON_TORONTO_M_FSAS = new Set(['M0R', 'M7R']);

/**
 * Every municipality a validated FSA could belong to — empty when it is outside the
 * covered set. More than one entry means the FSA straddles a boundary, which the
 * matcher treats as "residency unconfirmed".
 */
export function municipalitiesForFsa(fsa: string): readonly Municipality[] {
  if (fsa.startsWith('M')) return NON_TORONTO_M_FSAS.has(fsa) ? [] : ['toronto'];
  return FSA_MUNICIPALITIES[fsa] ?? [];
}
