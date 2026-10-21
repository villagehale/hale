// Inspect byte round-trips, not a list of suspicious words; never rewrite the body.
const legacyBytes = ['windows-1252', 'iso-8859-2'].map((label) => {
  const decoder = new TextDecoder(label);
  return new Map(
    Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte] as const),
  );
});
// Node's TextDecoder has no ISO-8859-16; retain its standard 0xA0–0xFF mapping.
const iso885916 =
  '\u00a0ĄąŁ€„Š§š©Ș«Ź\u00adźŻ°±ČłŽ”¶·žčș»ŒœŸżÀÁÂĂÄĆÆÇÈÉÊËÌÍÎÏĐŃÒÓÔŐÖŚŰÙÚÛÜĘȚßàáâăäćæçèéêëìíîïđńòóôőöśűùúûüęțÿ';
legacyBytes.push(
  new Map([
    ...Array.from({ length: 160 }, (_, byte) => [String.fromCharCode(byte), byte] as const),
    ...Array.from(iso885916, (char, index) => [char, index + 160] as const),
  ]),
);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function hasEncodingCorruption(message: string): boolean {
  if (message.includes('\uFFFD')) return true;
  const chars = Array.from(message);
  for (const encoding of legacyBytes) {
    for (let index = 0; index < chars.length; index++) {
      const lead = encoding.get(chars[index] ?? '');
      if (lead === undefined || lead < 0xc2 || lead > 0xf4) continue;
      const width = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      const span = chars.slice(index, index + width);
      const bytes = span.map((char) => encoding.get(char));
      if (bytes.length !== width || bytes.some((byte) => byte === undefined)) continue;
      try {
        if (utf8.decode(Uint8Array.from(bytes as number[])) !== span.join('')) return true;
      } catch {
        // Ordinary accented text does not form a second valid UTF-8 encoding.
      }
    }
  }
  return false;
}
