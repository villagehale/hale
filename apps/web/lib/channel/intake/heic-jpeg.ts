import { createRequire } from 'node:module';

/**
 * iPhone photos arrive as HEIC. The model image block accepts JPEG, PNG, and
 * WebP, and the sharp build Hale ships cannot decode HEVC. `heic-convert`
 * can. A failure is null: the turn names the image unread and does not throw.
 */

const require = createRequire(import.meta.url);

type HeicConvert = (args: {
  buffer: Buffer;
  format: 'JPEG';
  quality: number;
}) => Promise<ArrayBuffer>;

const convert = require('heic-convert') as HeicConvert;

const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'mif1', 'hevc', 'msf1']);

/** ISO-BMFF `ftyp` box, the same brands `files/mime.ts` calls HEIC. */
export function looksLikeHeic(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    HEIC_BRANDS.has(bytes.toString('ascii', 8, 12))
  );
}

export async function heicToJpeg(bytes: Buffer): Promise<Buffer | null> {
  if (!looksLikeHeic(bytes)) return null;
  try {
    const out = await convert({ buffer: bytes, format: 'JPEG', quality: 0.85 });
    const jpeg = Buffer.from(out);
    if (jpeg.length < 3 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) return null;
    return jpeg;
  } catch (err) {
    console.info(
      { reason: 'convert_failed', err: err instanceof Error ? err.name : 'unknown' },
      'intake photo: heic unread',
    );
    return null;
  }
}
