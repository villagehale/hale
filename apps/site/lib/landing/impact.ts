/**
 * The landing's impact band (VIL-250 · M14) — families covered, registrations
 * caught, weeks planned.
 *
 * It stays null until the X1 loop-health metrics are wired to a real count, and
 * the landing omits the whole section while it is: a metrics band showing zeros
 * (or a rounded-up guess) would be the page claiming something that isn't true,
 * which is the one thing this pivot may not do. Returning the numbers here is
 * the only change needed to light it up.
 */
export interface ImpactNumber {
  value: string;
  label: string;
}

export function impactNumbers(): readonly ImpactNumber[] | null {
  return null;
}
