import { municipalitiesForFsa } from '../registration/fsa-municipalities';
import { townLabel } from './town-label';

/**
 * The town a stored postal code or coarse area names, or null when it names none
 * or two. `L3P` and `L3P 3J7` are the same area. A city name stored in the area
 * column is not an FSA and resolves to null — the caller then keeps the city
 * only when no postal area wins.
 *
 * Relative imports only, so the coach eval can load it through context.ts.
 */
export function townFromStoredArea(area: string | null | undefined): string | null {
  if (!area) return null;
  const fsa = area.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  if (!/^[A-Z]\d[A-Z]$/.test(fsa)) return null;
  const municipalities = municipalitiesForFsa(fsa);
  const only = municipalities.length === 1 ? municipalities[0] : null;
  return only ? townLabel(only) : null;
}
