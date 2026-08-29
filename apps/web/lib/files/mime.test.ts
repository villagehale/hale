import { describe, expect, it } from 'vitest';
import { sniffMime } from './mime.js';

/**
 * Pure unit tests for the byte-sniff validator. sniffMime is the load-bearing
 * check behind every upload (the declared Content-Type is never trusted, rule #1).
 * Expected values are derived from the spec (magic-byte tables), never copied from
 * code output.
 */

describe('sniffMime — true type from leading bytes, not the declared type', () => {
  it('recognizes %PDF as application/pdf', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n...', 'ascii'))).toBe('application/pdf');
  });

  it('recognizes the JPEG SOI magic (ff d8 ff)', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
  });

  it('recognizes the PNG 8-byte signature', () => {
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe(
      'image/png',
    );
  });

  it("recognizes a HEIC ftyp box (bytes 4-7 'ftyp', 8-11 'heic')", () => {
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic', 'ascii'),
    ]);
    expect(sniffMime(heic)).toBe('image/heic');
  });

  it('returns null for bogus bytes (rejected → 415 upstream)', () => {
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]))).toBeNull();
    // A JPEG-declared payload whose bytes are actually text is NOT sniffed as an image.
    expect(sniffMime(Buffer.from('this is plain text, not a jpeg', 'ascii'))).toBeNull();
  });
});
