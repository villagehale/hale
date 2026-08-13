import type { Municipality } from '@hale/db';

/**
 * VIL-236 · M1 — Forward Sortation Area (the first three characters of a postal code)
 * to municipality, for the GTA towns the registration radar covers. Also the radius the
 * village intros matcher pairs families inside, which is why the confidence bar below is
 * the bar it is: a wrong entry here both misdates a registration and widens who a family
 * can be introduced to.
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
 * 5. The source tabulates several FSAs under a COMMUNITY rather than its town, so a
 *    search for the town name returns nothing and the FSA looks unassigned. Georgetown
 *    (L7G) and Acton (L7J) are Halton Hills; Bolton (L7E), Caledon East and Caledon
 *    Village (L7C, L7K) are Caledon. Read the community names, not just the town ones.
 *
 * Sources: Canada Post's published FSA assignments as tabulated in
 * https://en.wikipedia.org/wiki/List_of_postal_codes_of_Canada:_L and
 * https://en.wikipedia.org/wiki/List_of_postal_codes_of_Canada:_M, spot-corroborated
 * against GeoNames for the disputed Thornhill codes. Verified 2026-07-30; Brampton,
 * Caledon, Ajax, Pickering, Whitby, Oshawa and Aurora added and verified 2026-08-12
 * against the same tables, with L7A (Brampton, not Caledon's adjacent Mayfield West)
 * and L7E (Bolton, Caledon's largest community) double-checked per-code.
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

  // ── Brampton ──
  L6P: ['brampton'],
  L6R: ['brampton'],
  L6S: ['brampton'],
  L6T: ['brampton'],
  L6V: ['brampton'],
  L6W: ['brampton'],
  L6X: ['brampton'],
  L6Y: ['brampton'],
  L6Z: ['brampton'],
  L7A: ['brampton'],

  // ── Caledon ──
  L7C: ['caledon'],
  L7E: ['caledon'],
  L7K: ['caledon'],

  // ── Ajax ──
  L1S: ['ajax'],
  L1T: ['ajax'],
  L1Z: ['ajax'],

  // ── Pickering ──
  L1V: ['pickering'],
  L1W: ['pickering'],
  L1X: ['pickering'],
  L1Y: ['pickering'],

  // ── Whitby ──
  L1M: ['whitby'],
  L1N: ['whitby'],
  L1P: ['whitby'],
  L1R: ['whitby'],

  // ── Oshawa ──
  L1G: ['oshawa'],
  L1H: ['oshawa'],
  L1J: ['oshawa'],
  L1K: ['oshawa'],
  L1L: ['oshawa'],

  // ── Aurora ──
  L4G: ['aurora'],
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

/** The reverse index, over UNAMBIGUOUS entries only: an FSA recorded as straddling two
 * towns belongs to neither list, the same way `resolveFamilyOpen` declines to claim
 * residency for one. Toronto is absent by construction — it is a rule, not a list. */
const MUNICIPALITY_FSAS: ReadonlyMap<Municipality, readonly string[]> = (() => {
  const index = new Map<Municipality, string[]>();
  for (const [fsa, municipalities] of Object.entries(FSA_MUNICIPALITIES)) {
    if (municipalities.length !== 1) continue;
    const only = municipalities[0] as Municipality;
    const bucket = index.get(only);
    if (bucket) bucket.push(fsa);
    else index.set(only, [fsa]);
  }
  for (const bucket of index.values()) bucket.sort();
  return index;
})();

/**
 * Every FSA that resolves to this municipality alone — the inverse of
 * {@link municipalitiesForFsa}, and the width of the municipality on the map.
 *
 * EMPTY FOR TORONTO, and that is the table being honest rather than a gap: the entire M
 * range is Toronto (see limit 1), so there is no list to return and a caller that wants
 * a Toronto radius has to decide what it means for a city of three million. Callers
 * handle the M range before they get here.
 */
export function fsasForMunicipality(municipality: Municipality): readonly string[] {
  return MUNICIPALITY_FSAS.get(municipality) ?? [];
}
