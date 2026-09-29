import type { FieldSlot, PageControl } from '../../types';
import { classifySafetyField } from '../safety';
import { classifyAppointmentField } from './appointments';
import { classifyClassField } from './classes';
import { classifyContactField } from './contact';
import { classifyReservationField } from './reservations';
import { classifyTicketField } from './tickets';

export type ClassifiedField = FieldSlot | 'payment' | 'login' | 'unknown';

/**
 * Adapters name fields Hale already knows how to fill. They are not a list
 * of allowed categories. A booking of any kind uses this same path. Safety
 * (payment, login, a second factor) wins over every adapter.
 */
export function classifyField(control: PageControl): ClassifiedField {
  return (
    classifySafetyField(control) ??
    classifyClassField(control) ??
    classifyReservationField(control) ??
    classifyAppointmentField(control) ??
    classifyTicketField(control) ??
    classifyContactField(control) ??
    'unknown'
  );
}
