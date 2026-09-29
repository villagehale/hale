import type { FieldSlot, PageControl } from '../../types';
import { controlHay } from '../hay';

/** Contact fields shared by every private booking page. */
export function classifyContactField(control: PageControl): FieldSlot | null {
  const hay = controlHay(control);
  if (/\bemail\b/.test(hay)) return 'parent_email';
  if (/postal|postcode|\bzip\b/.test(hay)) return 'postal_code';
  if (
    /parent (first|given)|guardian first|guardian name|your name|contact name|booker name/.test(hay)
  ) {
    return 'parent_first_name';
  }
  return null;
}
