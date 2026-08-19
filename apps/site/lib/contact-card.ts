import { SITE_URL } from './app-url';

/**
 * Hale's saved-contact card, as vCard 3.0 (RFC 2426).
 *
 * A parent who saves this once sees the navy turtle and the name "Hale" beside
 * every later text, instead of an unknown number they have to recognise. That is
 * the whole job: the card carries no parent data and asks for none — it is Hale's
 * own contact details travelling outward.
 *
 * Written by hand rather than pulled from a library because the format is nine
 * lines and the only hard part is the fold: RFC 2426 caps a physical line at 75
 * octets and continues it with CRLF + one space. iOS enforces that, and a photo
 * on an over-long line is dropped silently — the contact saves, the avatar just
 * never appears.
 */

/** Where the card is served. Dotted, so the i18n middleware leaves it alone and
 * it stays one URL across all three locales. */
export const CONTACT_CARD_PATH = '/hale.vcf';

/** RFC 2426 §2.6: physical lines are folded at 75 octets, excluding the CRLF. */
export const VCARD_OCTET_LIMIT = 75;

const CRLF = '\r\n';
const ENCODER = new TextEncoder();

/** The card's one sentence of self-description. No commas, semicolons, or
 * backslashes — those would need escaping under RFC 2426 §4. */
const NOTE = 'Hale — the family assistant you text.';

/**
 * One logical line as the physical lines a parser reads: the first up to `limit`
 * octets, each continuation a space plus up to `limit - 1` more. Measured in
 * octets and split on code-point boundaries, so the NOTE's em dash survives.
 */
export function foldLine(line: string, limit: number): string {
  const physical: string[] = [];
  let current = '';
  let width = 0;

  for (const char of line) {
    const size = ENCODER.encode(char).length;
    // Continuations spend one octet on the leading space.
    const room = physical.length === 0 ? limit : limit - 1;
    if (width + size > room) {
      physical.push(current);
      current = '';
      width = 0;
    }
    current += char;
    width += size;
  }
  physical.push(current);

  return physical.join(`${CRLF} `);
}

/** The card for a provisioned number and an already-base64'd JPEG photo. */
export function buildVCard(smsNumber: string, photoJpegBase64: string): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Hale;;;;',
    'FN:Hale',
    'ORG:Hale',
    `TEL;TYPE=CELL:${smsNumber}`,
    `URL:${SITE_URL}`,
    `NOTE:${NOTE}`,
    `PHOTO;ENCODING=b;TYPE=JPEG:${photoJpegBase64}`,
    'END:VCARD',
  ];

  return `${lines.map((line) => foldLine(line, VCARD_OCTET_LIMIT)).join(CRLF)}${CRLF}`;
}
