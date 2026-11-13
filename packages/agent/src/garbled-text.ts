/**
 * Text no writer meant, which the parent's phone would show exactly as written. It is an
 * encoding check, never a word list. Two shapes:
 *
 * 1. Characters with no place in a text: U+FFFD (a decoder already gave up), an unpaired
 *    surrogate (half an emoji), and control characters other than tab and line breaks.
 *
 * 2. UTF-8 read back in a one-byte code page: "é" as "Ã©", "Ă©", "รฉ", "Γ©" or "أ©", "’"
 *    as "â€™". Each run of non-ASCII characters is turned back into the bytes a code page
 *    gives it, and if those bytes are well-formed UTF-8 the run is a broken character.
 *    Every one-byte page Node decodes is read, plus ISO-8859-16, which Node's ICU lacks
 *    and is spelled out below. Writers have come back in many of them (VIL-608 saw
 *    ISO-8859-2, -7, -13 and windows-1256 for one Spanish line).
 *
 * A run inside a Latin word counts when it reads back as a character a writer means
 * there: a Latin letter, punctuation or an emoji. Capital Polish "ĘŚ" reads back as IPA
 * "ʌ" and German "ß“" as an N'Ko letter, so neither counts.
 *
 * A run of three or more outside a Latin word ("â€”" between spaces, Arabic read as
 * windows-1252) counts when it reads back in windows-1252 or windows-1250, and so does a
 * two-character one that reads back as a Latin letter ("Ã" and a no-break space for "à").
 * windows-874 is left out of that case, because it is Thai: a Thai word such as "เขต" also
 * reads back as UTF-8. A run glued to the end of a Latin word that is one letter and then
 * only punctuation or a no-break space is an accented word before its closing marks
 * ("café…”", "fermé »"), not a run outside the word.
 */

const DECODED_PAGES = [
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
  'windows-874',
  'iso-8859-2',
  'iso-8859-3',
  'iso-8859-4',
  'iso-8859-5',
  'iso-8859-6',
  'iso-8859-7',
  'iso-8859-8',
  'iso-8859-10',
  'iso-8859-13',
  'iso-8859-14',
  'iso-8859-15',
  'macintosh',
  'x-mac-cyrillic',
  'ibm866',
  'koi8-r',
  'koi8-u',
] as const;
const STANDALONE_PAGES = new Set<string>(['windows-1252', 'windows-1250']);

// Node's ICU decodes windows-1252 0x80-0x9F as the C1 controls, so that half is spelled out.
// The five bytes windows-1252 leaves unassigned stay C1, which NEVER_MEANT refuses anyway.
const WINDOWS_1252_80_9F = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const ISO_8859_16_A0_FF =
  '\u00A0ĄąŁ€„Š§š©Ș«Ź\u00ADźŻ°±ČłŽ”¶·žčș»ŒœŸżÀÁÂĂÄĆÆÇÈÉÊËÌÍÎÏĐŃÒÓÔŐÖŚŰÙÚÛÜĘȚßàáâăäćæçèéêëìíîïđńòóôőöśűùúûüęțÿ';

type CodePage = { label: string; bytes: ReadonlyMap<string, number> };

function pageOf(label: string, charAt: (byte: number) => string | null): CodePage {
  const bytes = new Map<string, number>();
  for (let byte = 0x80; byte <= 0xff; byte += 1) {
    const char = charAt(byte);
    if (char !== null && char !== '\uFFFD' && !bytes.has(char)) bytes.set(char, byte);
  }
  return { label, bytes };
}

const CODE_PAGES: readonly CodePage[] = [
  ...DECODED_PAGES.map((label) => {
    const decoder = new TextDecoder(label);
    return pageOf(label, (byte) =>
      label === 'windows-1252' && byte < 0xa0
        ? (WINDOWS_1252_80_9F[byte - 0x80] as string)
        : decoder.decode(Uint8Array.of(byte)),
    );
  }),
  pageOf('iso-8859-16', (byte) =>
    byte < 0xa0 ? null : (ISO_8859_16_A0_FF[byte - 0xa0] as string),
  ),
];

const NEVER_MEANT = /\uFFFD|[\uD800-\uDFFF]|(?![\t\n\r])\p{Cc}/u;
// A no-break space joins a run: "à" read back in windows-1252 is "Ã" and one.
const RUN = /(?:[^\p{ASCII}\s]|\u00A0){2,}/gu;
const LATIN_LETTER = /[A-Za-z]/;
/** Characters a writer means inside a Latin word: Latin letters a parent's language uses,
 * punctuation, currency, letterlike symbols, and emoji. */
const MEANT_IN_WORD =
  /^(?:[\u00A0-\u017F\u01A0-\u01B0\u01CD-\u01DC\u0218-\u021B\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20CF\u2100-\u214F]|\uFE0F|\p{Extended_Pictographic}|\p{Emoji_Modifier})+$/u;
const LATIN_MEANT = /^[\u00A0-\u017F\u01A0-\u01B0\u01CD-\u01DC\u0218-\u021B\u1E00-\u1EFF]+$/u;
const LETTER_THEN_PUNCTUATION = /^\p{L}[\p{P}\u00A0]+$/u;

function asUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readsBackAs(run: string, byteOf: ReadonlyMap<string, number>): string | null {
  const bytes = [...run].map((char) => byteOf.get(char));
  if (!bytes.every((byte) => byte !== undefined)) return null;
  return asUtf8(Uint8Array.from(bytes));
}

function brokenInWord(run: string): boolean {
  return CODE_PAGES.some(({ bytes }) => {
    const decoded = readsBackAs(run, bytes);
    return decoded !== null && MEANT_IN_WORD.test(decoded);
  });
}

function brokenStandingAlone(run: string): boolean {
  return CODE_PAGES.some(({ label, bytes }) => {
    if (!STANDALONE_PAGES.has(label)) return false;
    const decoded = readsBackAs(run, bytes);
    if (decoded === null) return false;
    return [...run].length >= 3 || LATIN_MEANT.test(decoded);
  });
}

export function hasGarbledText(text: string): boolean {
  if (NEVER_MEANT.test(text)) return true;
  for (const match of text.matchAll(RUN)) {
    const run = match[0];
    const before = text[match.index - 1] ?? '';
    const after = text[match.index + run.length] ?? '';
    const inWord = LATIN_LETTER.test(before) || LATIN_LETTER.test(after);
    if (inWord && brokenInWord(run)) return true;
    if (LATIN_LETTER.test(before) && LETTER_THEN_PUNCTUATION.test(run)) continue;
    if (brokenStandingAlone(run)) return true;
  }
  return false;
}

/** True when any string anywhere inside a structured answer is garbled. */
export function holdsGarbledText(value: unknown): boolean {
  if (typeof value === 'string') return hasGarbledText(value);
  if (Array.isArray(value)) return value.some(holdsGarbledText);
  if (value && typeof value === 'object') return Object.values(value).some(holdsGarbledText);
  return false;
}
