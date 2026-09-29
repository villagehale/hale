import type { FieldSlot, PageControl } from '../../types';
import { controlHay } from '../hay';

/**
 * Kids classes, camps, drop-in play, gym sessions, sports leagues, and lessons.
 * A player or camper name is the child. The slot is the class or drop-in time.
 */
export function classifyClassField(control: PageControl): FieldSlot | null {
  const hay = controlHay(control);
  if (
    /child (first|given)|participant first|camper first|kid first|child name|player first|athlete first|student first|player name|athlete name|birthday child/.test(
      hay,
    )
  ) {
    return 'child_first_name';
  }
  if (/child (last|family|surname)|participant last|player last/.test(hay))
    return 'child_last_name';
  if (/\bdob\b|date of birth|birth date|birthdate/.test(hay)) return 'child_dob';
  if (
    /\bsession\b|class time|drop in time|league time|lesson time|practice time|game time|camp time|gym time|open gym/.test(
      hay,
    )
  ) {
    return 'session';
  }
  return null;
}
