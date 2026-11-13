/**
 * Text a model wrote as UTF-8 bytes read back in a one-byte code page: "é" as "Ã©", "Ă©" or
 * "รฉ", "’" as "â€™". The parent's phone shows exactly that, so a gate refuses it. It is an
 * encoding check, never a word list: each run of non-ASCII characters inside a Latin word is
 * turned back into the bytes a code page gives it, and if those bytes are well-formed UTF-8
 * the run is a broken letter.
 *
 * The code pages are the ones Sonnet 5.5 has written in the recorded evals, sometimes three
 * different ones for the same French text. ISO-8859-16 ("ĂȘ" for "ê") was seen too; Node's
 * ICU cannot read it, and its "Ă©" for "é" is the same as windows-1250's.
 *
 * A run counts only when it touches a Latin letter: a short Thai word such as "รถ" also reads
 * back as UTF-8, but it is not a letter broken inside a Latin word.
 */

const CODE_PAGES = ['windows-1252', 'windows-1250', 'windows-874'] as const;

const BYTE_OF: readonly ReadonlyMap<string, number>[] = CODE_PAGES.map((label) => {
  const decoder = new TextDecoder(label);
  const bytes = new Map<string, number>();
  for (let byte = 0x80; byte <= 0xff; byte += 1) {
    bytes.set(decoder.decode(Uint8Array.of(byte)), byte);
  }
  return bytes;
});

const RUN_IN_LATIN_WORD = /(?<=[A-Za-z])[^\p{ASCII}\s]{2,}|[^\p{ASCII}\s]{2,}(?=[A-Za-z])/gu;

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function hasGarbledText(text: string): boolean {
  for (const [run] of text.matchAll(RUN_IN_LATIN_WORD)) {
    for (const byteOf of BYTE_OF) {
      const bytes = [...run].map((char) => byteOf.get(char));
      if (bytes.every((byte) => byte !== undefined) && isUtf8(Uint8Array.from(bytes))) {
        return true;
      }
    }
  }
  return false;
}
