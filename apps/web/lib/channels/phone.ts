/**
 * Phone-number handling for the SMS channel. v1 is CA + US only — both share the
 * North American Numbering Plan (country code +1, a 10-digit national number where
 * the area code and the exchange code each start 2-9). We validate to that shape
 * and store the canonical E.164 form; anything else is rejected at the boundary
 * (rule: validate + bound inputs) rather than sent to a carrier.
 */

/** NANP E.164: +1, area code [2-9]XX, exchange [2-9]XX, 4-digit line. */
const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * Coerce a human-entered number to canonical NANP E.164, or null if it isn't a
 * valid CA/US number. Accepts spaces, dashes, dots, parens, an optional leading
 * `+1` or `1`, or a bare 10-digit number. Never throws.
 */
export function normalizePhoneE164(raw: string): string | null {
  // Bound the input before any O(n) scan — a NANP number is ≤12 digits, ~17 chars
  // even fully formatted; anything much longer is junk (or an attempt to make the
  // regex/hash chew a huge authed payload), rejected in O(1).
  if (raw.length > 24) return null;

  const trimmed = raw.trim();
  // Reject anything with letters or unexpected symbols before we strip — a valid
  // number contains only digits and the formatting set below.
  if (/[^\d\s()+.\-]/.test(trimmed)) return null;

  const digits = trimmed.replace(/[^\d]/g, '');
  // 10 digits → prepend the +1 country code; 11 digits → must already be a 1-prefixed
  // NANP number.
  let e164: string;
  if (digits.length === 10) {
    e164 = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    e164 = `+${digits}`;
  } else {
    return null;
  }

  return NANP_E164.test(e164) ? e164 : null;
}

/**
 * Mask a stored E.164 number for display — reveal only the last four digits so a
 * parent recognises their own number without the full value appearing in the UI
 * (rule #1). Assumes a canonical E.164 value (as produced by normalizePhoneE164).
 */
export function maskPhoneE164(e164: string): string {
  const last4 = e164.slice(-4);
  return `••• ••• ${last4}`;
}
