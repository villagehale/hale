/**
 * Text no writer meant, which the parent's phone would show exactly as written. It is an
 * encoding check, never a word list. Two shapes:
 *
 * 1. Characters with no place in a text: U+FFFD (a decoder already gave up), an unpaired
 *    surrogate (half an emoji), and control characters other than tab and line breaks.
 *
 * 2. UTF-8 read back in a one-byte code page: "é" as "Ã©", "Ă©" or "รฉ", "’" as "â€™".
 *    Each run of non-ASCII characters is turned back into the bytes a code page gives it,
 *    and if those bytes are well-formed UTF-8 the run is a broken character.
 *
 * The code pages are the ones Sonnet 5.5 has written in the recorded evals, sometimes three
 * different ones for the same French text. ISO-8859-16 ("ĂȘ" for "ê") was seen too; Node's
 * ICU cannot read it, and its "Ă©" for "é" is the same as windows-1250's, so only that
 * shared half is caught.
 *
 * A run inside a Latin word counts when it reads back as a Latin letter or punctuation:
 * German "Gruß“" reads back as one N'Ko letter, which is not a broken letter. A run that
 * touches no Latin letter ("â€”" between spaces, Arabic read as windows-1252) counts when it
 * is three characters or more in windows-1252 or windows-1250. windows-874 is left out of
 * that case, because it is Thai: a short Thai word such as "รถ" also reads back as UTF-8.
 */

const CODE_PAGES = ['windows-1252', 'windows-1250', 'windows-874'] as const;
const STANDALONE_CODE_PAGES = new Set<string>(['windows-1252', 'windows-1250']);

// Node's ICU decodes windows-1252 0x80-0x9F as the C1 controls, so that half is spelled out.
// The five bytes windows-1252 leaves unassigned stay C1, which NEVER_MEANT refuses anyway.
const WINDOWS_1252_80_9F = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

const BYTE_OF: readonly { label: string; bytes: ReadonlyMap<string, number> }[] = CODE_PAGES.map(
  (label) => {
    const decoder = new TextDecoder(label);
    const bytes = new Map<string, number>();
    for (let byte = 0x80; byte <= 0xff; byte += 1) {
      const char =
        label === 'windows-1252' && byte < 0xa0
          ? (WINDOWS_1252_80_9F[byte - 0x80] as string)
          : decoder.decode(Uint8Array.of(byte));
      bytes.set(char, byte);
    }
    return { label, bytes };
  },
);

const NEVER_MEANT = /\uFFFD|[\uD800-\uDFFF]|(?![\t\n\r])\p{Cc}/u;
const RUN_IN_LATIN_WORD = /(?<=[A-Za-z])[^\p{ASCII}\s]{2,}|[^\p{ASCII}\s]{2,}(?=[A-Za-z])/gu;
const STANDALONE_RUN = /[^\p{ASCII}\s]{3,}/gu;
const LATIN_OR_PUNCTUATION = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;

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

export function hasGarbledText(text: string): boolean {
  if (NEVER_MEANT.test(text)) return true;
  for (const [run] of text.matchAll(RUN_IN_LATIN_WORD)) {
    for (const { bytes } of BYTE_OF) {
      const decoded = readsBackAs(run, bytes);
      if (decoded !== null && LATIN_OR_PUNCTUATION.test(decoded)) return true;
    }
  }
  for (const [run] of text.matchAll(STANDALONE_RUN)) {
    for (const { label, bytes } of BYTE_OF) {
      if (STANDALONE_CODE_PAGES.has(label) && readsBackAs(run, bytes) !== null) return true;
    }
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
