/**
 * VIL-640. The FSA every journey and synthetic-family test uses.
 *
 * `K7L` is a real Canadian forward sortation area (Kingston, Ontario). It is
 * code-valid, so parsers that check FSA shape accept it. It is not in the GTA.
 * No Hale family in this repository is tied to it. This file does not claim
 * anyone lives there.
 *
 * Geography tables still list GTA FSAs (including L7G) because they describe
 * Canada Post, not a household. The privacy page still publishes the business
 * address. Do not copy a real family's postal code into a fixture.
 */

export const FIXTURE_FSA = 'K7L';
export const FIXTURE_POSTAL = 'K7L 1A1';
export const FIXTURE_CITY = 'Kingston';
export const FIXTURE_PROVINCE = 'Ontario';
export const FIXTURE_COUNTRY = 'Canada';

/**
 * What `activityPlaceOf` returns for {@link FIXTURE_FSA}: Kingston is outside the
 * GTA municipality table, so the find searches the postal-cities spelling.
 */
export const FIXTURE_FIND_TOWN = 'Kingston, Ontario, Canada';
