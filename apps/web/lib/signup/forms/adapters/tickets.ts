import type { FieldSlot, PageControl } from '../../types';
import { controlHay } from '../hay';

/**
 * Museum, attraction, show, zoo, and aquarium tickets.
 * A date page with no time slot is a cart step. The adult name is the holder.
 */
export function classifyTicketField(control: PageControl): FieldSlot | null {
  const hay = controlHay(control);
  if (/visit date|show date|performance date|entry date|timed entry date/.test(hay)) {
    return 'visit_date';
  }
  if (
    /showtime|show time|performance time|entry time|visit time|timed entry|time slot|timeslot/.test(
      hay,
    )
  ) {
    return 'session';
  }
  if (/ticket quantity|number of tickets/.test(hay)) return 'party_size';
  if (/guest name|visitor name|ticket holder/.test(hay)) return 'parent_first_name';
  return null;
}
