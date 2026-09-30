import type { FieldSlot, PageControl } from '../../types';
import { controlHay } from '../hay';

/**
 * Restaurant reservations and birthday-party venues.
 * Party size and a seating note are filled only from the authorized session.
 */
export function classifyReservationField(control: PageControl): FieldSlot | null {
  const hay = controlHay(control);
  if (/party date|reservation date/.test(hay)) return 'visit_date';
  if (/party size|guest count|number of guests|headcount|party of/.test(hay)) return 'party_size';
  if (/seating note|seating request|table note|table request/.test(hay)) return 'seating_note';
  if (/reservation time|seating time|party time/.test(hay)) return 'session';
  if (/reservation name/.test(hay)) return 'parent_first_name';
  return null;
}
