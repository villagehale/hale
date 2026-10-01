import { isShareableSignupField } from '../consent';
import { noteStops } from '../forms/safety';
import type { ConnectorBookingSlot } from '../providers';
import type { FieldSlot, SignupIdentity, SignupSession, SignupStopReason } from '../types';

export type ConnectorSlotsResult =
  | { ok: true; slots: ConnectorBookingSlot[] }
  | { ok: false; reason: SignupStopReason };

/**
 * The closed slot list a partnership call may carry.
 *
 * Only names the consent grant already lists, and only when a value is
 * already on the offer or the family record. The family record itself is
 * not returned. A seating note that reads as health, allergy, or a waiver
 * stops the call.
 */
export function connectorBookingSlots(input: {
  identity: SignupIdentity;
  session: Pick<SignupSession, 'id' | 'startsAt' | 'partySize' | 'seatingNote'>;
  fieldsAllowed: readonly string[];
}): ConnectorSlotsResult {
  const note = input.session.seatingNote?.trim() ?? '';
  if (note.length > 0 && input.fieldsAllowed.includes('seating_note')) {
    const stopped = noteStops(note);
    if (stopped) return { ok: false, reason: stopped };
    if (note.length > 80) return { ok: false, reason: 'missing_detail' };
  }

  const partySize = input.session.partySize ?? null;
  const values: Record<FieldSlot, string | null> = {
    child_first_name: text(input.identity.childFirstName),
    child_last_name: text(input.identity.childLastName),
    child_dob: text(input.identity.childDob),
    parent_first_name: text(input.identity.parentFirstName),
    parent_email: text(input.identity.parentEmail),
    postal_code: text(input.identity.postalCode),
    session: text(input.session.id),
    visit_date: /^(\d{4}-\d{2}-\d{2})/.exec(input.session.startsAt)?.[1] ?? null,
    party_size:
      typeof partySize === 'number' && Number.isInteger(partySize) && partySize >= 1
        ? String(partySize)
        : null,
    seating_note: note.length > 0 ? note : null,
  };

  const slots: ConnectorBookingSlot[] = [];
  for (const field of input.fieldsAllowed) {
    if (!isShareableSignupField(field)) continue;
    const value = values[field];
    if (!value) continue;
    slots.push({ slot: field, value });
  }
  return { ok: true, slots };
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}
