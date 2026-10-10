/**
 * The name `search_village` hands the model.
 *
 * A stored title and a stored venue are two columns. Spoken together they are
 * often the same place twice: "Riverdale Farm visit" at "Riverdale Farm". The
 * model then quotes both, because that is what it was given. The title it
 * should quote is the one a parent would say, and the venue is only attached
 * when it names a different place.
 */

/** What is left of a title once the venue is lifted out, when that leftover is
 * not a programme. "visit" is not a second name for the farm. */
const GENERIC_TITLE_TAIL = new Set(['visit', 'outing', 'drop-in', 'drop in', 'event', 'activity']);

export interface SpokenFind {
  /** Quote this. It does not repeat the venue. */
  title: string;
  /** A place the title does not already name. Null when attaching it would
   * say the same place again. */
  venue: string | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function spokenFind(title: string, venue: string): SpokenFind {
  const name = title.trim().replace(/\s+/g, ' ');
  const place = venue.trim().replace(/\s+/g, ' ');
  if (place === '') return { title: name, venue: null };

  const nameLower = name.toLowerCase();
  const placeLower = place.toLowerCase();
  if (nameLower === placeLower || !nameLower.includes(placeLower)) {
    return nameLower === placeLower ? { title: name, venue: null } : { title: name, venue: place };
  }

  const rest = name
    .replace(new RegExp(escapeRegExp(place), 'ig'), ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
  if (rest === '' || GENERIC_TITLE_TAIL.has(rest)) return { title: place, venue: null };
  // The title already contains the place and a real programme name. Keep it,
  // and do not hand the place back a second time.
  return { title: name, venue: null };
}
