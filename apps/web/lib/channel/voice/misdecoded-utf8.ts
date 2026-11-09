// No `~/` imports: the said-line eval loads this file directly (tsImport).

/**
 * The single-byte code pages a writer's UTF-8 has come back read through (VIL-608: the
 * Spanish soft close came back as ISO-8859-2, -7, -13 and windows-1256, e.g. "presentaciĂłn").
 */
const SINGLE_BYTE_PAGES = [
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
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'windows-1253',
  'windows-1254',
  'windows-1255',
  'windows-1256',
  'windows-1257',
  'windows-1258',
] as const;

const byteOf = new Map<string, Map<string, number>>();

function pageBytes(page: string): Map<string, number> {
  let map = byteOf.get(page);
  if (map) return map;
  map = new Map();
  const decoder = new TextDecoder(page);
  for (let b = 0x80; b <= 0xff; b++) {
    const ch = decoder.decode(Uint8Array.of(b));
    if (ch !== '�' && !map.has(ch)) map.set(ch, b);
  }
  byteOf.set(page, map);
  return map;
}

function encodeIn(page: string, text: string): Uint8Array | null {
  const map = pageBytes(page);
  const out = new Uint8Array(text.length);
  let i = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const byte = code < 0x80 ? code : map.get(ch);
    if (byte === undefined) return null;
    out[i++] = byte;
  }
  return out.subarray(0, i);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The text the writer meant, when the whole text is its UTF-8 bytes read through one
 * single-byte code page; otherwise the text unchanged. Correct text cannot round-trip:
 * its non-ASCII characters would have to pair up into valid UTF-8 sequences, which
 * accented letters, Arabic, CJK and emoji never do.
 */
export function repairMisdecodedUtf8(text: string): string {
  if (!/[\u0080-\uffff]/.test(text)) return text;
  for (const page of SINGLE_BYTE_PAGES) {
    const bytes = encodeIn(page, text);
    if (bytes === null) continue;
    try {
      const meant = strictUtf8.decode(bytes);
      if (meant !== text) return meant;
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
  }
  return text;
}
