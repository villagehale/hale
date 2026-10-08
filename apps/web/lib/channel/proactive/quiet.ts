/**
 * VIL-226 · one quiet window. 21:00–08:00 parent-local, and 20:00 for a Florida
 * or Oklahoma number (those states end the lawful texting day at 8pm).
 *
 * The evening check-in slot is already 20:00 for everyone. This clamp is the
 * floor under every other unprompted send once the parent's number is known.
 */

export const QUIET_HOURS_START = '21:00';
export const QUIET_HOURS_END = '08:00';
export const FLORIDA_OKLAHOMA_QUIET_START = '20:00';

/** NANP area codes whose texting day ends at 20:00. */
const FLORIDA_OKLAHOMA_AREA_CODES = new Set([
  '239',
  '305',
  '321',
  '352',
  '386',
  '407',
  '448',
  '561',
  '656',
  '689',
  '727',
  '754',
  '772',
  '786',
  '813',
  '850',
  '863',
  '904',
  '941',
  '954',
  '405',
  '539',
  '572',
  '580',
  '918',
]);

export function areaCodeOf(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return national.slice(0, 3);
}

export function floridaOrOklahoma(phone: string | null): boolean {
  const code = areaCodeOf(phone);
  return code !== null && FLORIDA_OKLAHOMA_AREA_CODES.has(code);
}

/** Quiet-hours start for this number. End stays 08:00. */
export function quietStartForPhone(phone: string | null): string {
  return floridaOrOklahoma(phone) ? FLORIDA_OKLAHOMA_QUIET_START : QUIET_HOURS_START;
}
