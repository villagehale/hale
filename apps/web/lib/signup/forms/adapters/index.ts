import type { FieldSlot, PageControl } from '../../types';
import { classifySafetyField } from '../safety';
import { classifyAppointmentField } from './appointments';
import { classifyClassField } from './classes';
import { classifyContactField } from './contact';
import { classifyReservationField } from './reservations';
import { classifyTicketField } from './tickets';

export type ClassifiedField = FieldSlot | 'payment' | 'login' | 'unknown';

/**
 * Adapters name the fields Hale knows how to fill. A new private-provider
 * shape is a new file here. The runner does not grow a branch per venue.
 * Safety (payment, login, a second factor) wins over every adapter.
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
