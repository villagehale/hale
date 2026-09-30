import type { SignupIdentity } from './types';

/** A fact the parent already holds, named by slot. No phone and no date of birth. */
export interface InfoPackSlot {
  slot:
    | 'child_first_name'
    | 'child_last_name'
    | 'parent_first_name'
    | 'parent_email'
    | 'postal_code';
  value: string;
}

/**
 * The minimum pack for an assisted handoff.
 *
 * These are the fields the form-fill path already knows how to type. Phone
 * stays out (it is encrypted and not used for signup). Date of birth stays
 * out, including an exact one: the parent already has it, and a derived date
 * must not be sent. Medical and allergy notes are not in this pack.
 */
export function signupInfoPack(identity: SignupIdentity): InfoPackSlot[] {
  const slots: InfoPackSlot[] = [];
  const add = (slot: InfoPackSlot['slot'], value: string | null) => {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length > 0) slots.push({ slot, value: trimmed });
  };
  add('child_first_name', identity.childFirstName);
  add('child_last_name', identity.childLastName);
  add('parent_first_name', identity.parentFirstName);
  add('parent_email', identity.parentEmail);
  add('postal_code', identity.postalCode);
  return slots;
}
