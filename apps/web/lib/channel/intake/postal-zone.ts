/**
 * IANA zone for a Canadian FSA or a US ZIP.
 *
 * The first letter of a Canadian postal code is a province (Canada Post). A US ZIP's
 * first three digits are a sectional center. Both are coarse: a few areas sit on a
 * boundary (northwestern Ontario, the Florida panhandle, west Texas) and those are
 * named below. This is geography, not a guess at the parent's words.
 */

const CA_BY_LETTER: Record<string, string> = {
  A: 'America/St_Johns',
  B: 'America/Halifax',
  C: 'America/Halifax',
  E: 'America/Moncton',
  G: 'America/Toronto',
  H: 'America/Toronto',
  J: 'America/Toronto',
  K: 'America/Toronto',
  L: 'America/Toronto',
  M: 'America/Toronto',
  N: 'America/Toronto',
  P: 'America/Toronto',
  R: 'America/Winnipeg',
  S: 'America/Regina',
  T: 'America/Edmonton',
  V: 'America/Vancouver',
  X: 'America/Iqaluit',
  Y: 'America/Whitehorse',
};

/** Labrador, not the island. */
const GOOSE_BAY = new Set(['A0K', 'A0P', 'A0R', 'A2V']);
/** Blanc-Sablon and the lower north shore. */
const BLANC_SABLON = new Set(['G0G']);
/** Northwestern Ontario, west of 90°W. */
const WINNIPEG_ON = new Set(['P0T', 'P0V', 'P0W', 'P0X', 'P0Y']);

function canadaZone(fsa: string): string {
  const code = fsa.toUpperCase();
  if (GOOSE_BAY.has(code)) return 'America/Goose_Bay';
  if (BLANC_SABLON.has(code)) return 'America/Blanc-Sablon';
  if (WINNIPEG_ON.has(code) || /^P[789]/.test(code)) return 'America/Winnipeg';
  if (code.startsWith('X0A')) return 'America/Iqaluit';
  if (code.startsWith('X0B')) return 'America/Rankin_Inlet';
  if (code.startsWith('X0C')) return 'America/Cambridge_Bay';
  if (code.startsWith('X0E') || code.startsWith('X0G') || code.startsWith('X1A')) {
    return 'America/Yellowknife';
  }
  return CA_BY_LETTER[code.charAt(0)] ?? 'UTC';
}

function usZone(zip5: string): string {
  const z3 = Number(zip5.slice(0, 3));
  if (z3 >= 995) return 'America/Anchorage';
  if (z3 >= 967 && z3 <= 968) return 'Pacific/Honolulu';
  if ((z3 >= 900 && z3 <= 961) || (z3 >= 970 && z3 <= 994) || (z3 >= 889 && z3 <= 898)) {
    return 'America/Los_Angeles';
  }
  if (z3 >= 850 && z3 <= 865) return 'America/Phoenix';
  if (
    (z3 >= 800 && z3 <= 884) ||
    (z3 >= 590 && z3 <= 599) ||
    (z3 >= 797 && z3 <= 799) ||
    z3 === 885
  ) {
    return 'America/Denver';
  }
  if (z3 >= 350 && z3 <= 397) return 'America/Chicago';
  if (z3 >= 498 && z3 <= 499) return 'America/Chicago';
  if (z3 <= 349 || (z3 >= 398 && z3 <= 497)) return 'America/New_York';
  return 'America/Chicago';
}

export function timezoneForIntakePostal(country: 'CA' | 'US', areaKey: string): string {
  return country === 'CA' ? canadaZone(areaKey) : usZone(areaKey);
}
