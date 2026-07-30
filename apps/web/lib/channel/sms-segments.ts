/**
 * How many SMS segments a body will actually be billed and delivered as.
 *
 * This is not cosmetic. A carrier splits a message by ENCODING, not by character
 * count: a body that is entirely GSM-7 carries 160 septets alone (153 per part once
 * concatenated, because the 6-byte concatenation header eats 7 septets), while ONE
 * character outside GSM-7 — a typographic em dash, a curly apostrophe, an emoji —
 * flips the whole body to UCS-2 and collapses the budget to 70 units (67 per part).
 * So "Hale — your week" costs more than twice what "Hale - your week" costs, for a
 * difference nobody reading it on a phone can see.
 *
 * The radar payload is the first thing Hale ever sends a stranger, and it is billed
 * per segment per family, so the composer holds itself to a segment budget rather than
 * a character count that would be wrong half the time.
 *
 * Reference: GSM 03.38 (the 7-bit default alphabet + its escape table) and 3GPP
 * TS 23.040 (concatenated short messages).
 */

/** The GSM 03.38 default alphabet. Every character here costs ONE septet. */
const GSM7_BASIC = new Set(
  [
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?',
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
  ]
    .join('')
    .split(''),
);

/** The GSM 03.38 extension table. Each of these costs TWO septets (escape + char). */
const GSM7_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export type SmsEncoding = 'gsm7' | 'ucs2';

const GSM7_SINGLE_MAX = 160;
const GSM7_CONCAT_PART = 153;
const UCS2_SINGLE_MAX = 70;
const UCS2_CONCAT_PART = 67;

/** The encoding a carrier will pick for this body. One out-of-alphabet character is
 * enough to make the whole message UCS-2. */
export function smsEncoding(text: string): SmsEncoding {
  for (const char of text) {
    if (!GSM7_BASIC.has(char) && !GSM7_EXTENDED.has(char)) return 'ucs2';
  }
  return 'gsm7';
}

/** Billable units in this body: septets under GSM-7 (extension characters count two),
 * UTF-16 code units under UCS-2 (which is what actually goes on the wire, so an astral
 * character costs two). */
function billableUnits(text: string, encoding: SmsEncoding): number {
  if (encoding === 'ucs2') return text.length;
  let septets = 0;
  for (const char of text) {
    septets += GSM7_EXTENDED.has(char) ? 2 : 1;
  }
  return septets;
}

/** How many segments `text` will be sent as. An empty body is still one send. */
export function smsSegments(text: string): number {
  const encoding = smsEncoding(text);
  const units = billableUnits(text, encoding);
  const single = encoding === 'gsm7' ? GSM7_SINGLE_MAX : UCS2_SINGLE_MAX;
  if (units <= single) return 1;
  const part = encoding === 'gsm7' ? GSM7_CONCAT_PART : UCS2_CONCAT_PART;
  return Math.ceil(units / part);
}
