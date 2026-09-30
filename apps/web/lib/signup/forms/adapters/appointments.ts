import type { FieldSlot, PageControl } from '../../types';
import { controlHay } from '../hay';

/** Haircuts and other private appointments. The client name is the parent. */
export function classifyAppointmentField(control: PageControl): FieldSlot | null {
  const hay = controlHay(control);
  if (/appointment date|booking date/.test(hay)) return 'visit_date';
  if (/appointment time|booking time/.test(hay)) return 'session';
  if (/client name|appointment name/.test(hay)) return 'parent_first_name';
  return null;
}
