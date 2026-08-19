import { describe, expect, it } from 'vitest';
import { SITE_URL } from './app-url.js';
import { VCARD_OCTET_LIMIT, buildVCard, foldLine } from './contact-card.js';

/**
 * The saved-contact card (/hale.vcf) — what a parent's phone reads when they tap
 * "Save Hale to your contacts", and the reason every later Hale text arrives with
 * the turtle beside it rather than beside an unknown number.
 *
 * Expected values come from RFC 2426 (vCard 3.0) and from the card's own spec —
 * FN/ORG "Hale", the number the site was configured with, the marketing origin,
 * one JPEG photo — never from what the implementation happens to emit. The fold
 * assertions matter most: iOS drops a photo whose base64 runs past the 75-octet
 * line limit, so a card that reads fine as a string is still broken on the only
 * device that counts.
 */

/** A stand-in for the provisioned number, which is never committed. */
const NUMBER = '+16475551234';
/** A JPEG's first bytes, base64'd — long enough to force several folded lines. */
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(600).fill(0x2a)]).toString('base64');

const card = buildVCard(NUMBER, PHOTO);

/** Physical lines exactly as a phone's parser sees them, CRLF-separated. */
function physicalLines(vcard: string): string[] {
  return vcard.split('\r\n').filter((line) => line !== '');
}

function octets(text: string): number {
  return new TextEncoder().encode(text).length;
}

function maxOctets(vcard: string): number {
  return Math.max(...physicalLines(vcard).map(octets));
}

/** Continuation lines rejoined — RFC 2426 unfolding: CRLF + one whitespace. */
function unfold(vcard: string): string[] {
  return physicalLines(vcard.replace(/\r\n[ \t]/g, ''));
}

describe('buildVCard — envelope and fields', () => {
  it('is a vCard 3.0 envelope, CRLF-terminated', () => {
    expect(card.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
    expect(card.endsWith('END:VCARD\r\n')).toBe(true);
    // A bare LF would end the card early on strict parsers.
    expect(card.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('names the contact Hale — the display name, the structured name, and the org', () => {
    const lines = unfold(card);
    expect(lines).toContain('FN:Hale');
    expect(lines).toContain('N:Hale;;;;');
    expect(lines).toContain('ORG:Hale');
  });

  it('carries the number it was given, as a mobile number', () => {
    expect(unfold(card)).toContain(`TEL;TYPE=CELL:${NUMBER}`);
    // Derived from the argument, not baked in: a different number moves the line.
    const other = buildVCard('+14165550199', PHOTO);
    expect(unfold(other)).toContain('TEL;TYPE=CELL:+14165550199');
    expect(other).not.toContain(NUMBER);
  });

  it('points at the site and says what Hale is', () => {
    const lines = unfold(card);
    expect(lines).toContain(`URL:${SITE_URL}`);
    expect(lines).toContain('NOTE:Hale — the family assistant you text.');
  });
});

describe('buildVCard — the photo', () => {
  it('embeds the JPEG as inline base64, and it survives unfolding byte-for-byte', () => {
    const photoLine = unfold(card).find((line) => line.startsWith('PHOTO')) ?? '';
    expect(photoLine).toMatch(/^PHOTO;ENCODING=b;TYPE=JPEG:/);
    const payload = photoLine.slice('PHOTO;ENCODING=b;TYPE=JPEG:'.length);
    // The bytes a phone decodes are the bytes we handed in — a fold that ate or
    // invented a character would still be valid base64 and still be wrong.
    expect(Buffer.from(payload, 'base64').equals(Buffer.from(PHOTO, 'base64'))).toBe(true);
  });

  it('folds every line to the 75-octet limit, continuations prefixed with one space', () => {
    expect(VCARD_OCTET_LIMIT).toBe(75);
    expect(maxOctets(card)).toBeLessThanOrEqual(VCARD_OCTET_LIMIT);
    const continuations = physicalLines(card).filter((line) => line.startsWith(' '));
    expect(continuations.length).toBeGreaterThan(5);
    for (const line of continuations) expect(line.startsWith('  ')).toBe(false);
  });

  it('positive control: the photo line unfolded blows the limit this card respects', () => {
    // Without this, `maxOctets(card) <= 75` would also pass on a card carrying no
    // photo at all. The same content, unfolded, must fail the very same check.
    expect(octets(`PHOTO;ENCODING=b;TYPE=JPEG:${PHOTO}`)).toBeGreaterThan(VCARD_OCTET_LIMIT);
  });
});

describe('foldLine — the rule iOS is strict about', () => {
  it('holds the limit including the continuation space, and unfolds back to the input', () => {
    const line = `PHOTO;ENCODING=b;TYPE=JPEG:${PHOTO}`;
    for (const limit of [VCARD_OCTET_LIMIT, 40, 12]) {
      const folded = foldLine(line, limit);
      for (const physical of folded.split('\r\n')) {
        expect(octets(physical), `folded at ${limit}`).toBeLessThanOrEqual(limit);
      }
      expect(folded.replace(/\r\n /g, '')).toBe(line);
    }
  });

  it('positive control: a wrong limit produces lines the 75-octet check rejects', () => {
    const folded = foldLine(`PHOTO;ENCODING=b;TYPE=JPEG:${PHOTO}`, 80);
    expect(Math.max(...folded.split('\r\n').map(octets))).toBeGreaterThan(VCARD_OCTET_LIMIT);
  });

  it('keeps multi-byte characters whole', () => {
    // The NOTE's em dash is three octets; a fold that counted characters could
    // split it and hand the phone a mojibake note.
    const note = 'NOTE:Hale — the family assistant you text.';
    const folded = foldLine(note, 12);
    for (const physical of folded.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(12);
    expect(folded.replace(/\r\n /g, '')).toBe(note);
    expect(folded).not.toContain('�');
  });

  it('leaves a line that already fits untouched', () => {
    expect(foldLine('FN:Hale', VCARD_OCTET_LIMIT)).toBe('FN:Hale');
  });
});
