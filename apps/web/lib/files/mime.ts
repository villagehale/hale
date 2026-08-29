/**
 * Byte-sniffed MIME detection for uploaded files. A client can lie in the declared
 * Content-Type, so callers validate the RAW bytes against this table, not the
 * declared type (rule #1). Shared by the coach attachments store and the
 * child-avatar store (formerly hosted by the retired Docs vault).
 */

/**
 * The accepted MIME allowlist → the leading magic bytes that prove it. HEIC has no
 * single fixed prefix (the 'ftyp' box sits at offset 4 with several brand codes),
 * so it is checked structurally in `sniffMime`, not by a flat prefix here.
 */
const MAGIC_PREFIXES: Record<string, readonly number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};

export const ACCEPTED_MIMES = [...Object.keys(MAGIC_PREFIXES), 'image/heic'] as const;

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'mif1', 'hevc', 'msf1']);

/**
 * Determines the true MIME from the leading bytes, independent of the declared
 * Content-Type. Returns null when the bytes match no accepted type — the route
 * rejects with 415. HEIC is detected by its ISO-BMFF 'ftyp' box: bytes 4–7 spell
 * 'ftyp' and bytes 8–11 carry a HEIC brand.
 */
export function sniffMime(bytes: Buffer): (typeof ACCEPTED_MIMES)[number] | null {
  for (const [mime, prefixes] of Object.entries(MAGIC_PREFIXES)) {
    if (prefixes.some((p) => startsWith(bytes, p))) {
      return mime as (typeof ACCEPTED_MIMES)[number];
    }
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    HEIC_BRANDS.has(bytes.toString('ascii', 8, 12))
  ) {
    return 'image/heic';
  }
  return null;
}
