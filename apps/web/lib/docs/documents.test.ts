import { describe, expect, it } from 'vitest';
import { _internal, MAX_TITLE_LENGTH, sanitizeTitle, sniffMime } from './documents.js';

/**
 * Pure unit tests for the Docs vault validators + the teen redaction gate — no db,
 * no route. sniffMime is the load-bearing byte-sniff (the declared Content-Type is
 * never trusted, rule #1); dropTeenDocuments is the load-bearing teen gate (rule #1)
 * and MUST fail if the gate is weakened. Expected values are derived from the spec
 * (magic-byte tables, 156-month stage boundary), never copied from code output.
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

describe('sanitizeTitle', () => {
  it('collapses runs of whitespace to single spaces and trims', () => {
    expect(sanitizeTitle('  Immunization\t\n  record  ')).toBe('Immunization record');
  });

  it('caps at MAX_TITLE_LENGTH characters', () => {
    const raw = 'a'.repeat(MAX_TITLE_LENGTH + 50);
    const out = sanitizeTitle(raw);
    expect(out).toHaveLength(MAX_TITLE_LENGTH);
    expect(out).toBe('a'.repeat(MAX_TITLE_LENGTH));
  });

  it('returns null for empty / all-whitespace titles', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle('   \t \n ')).toBeNull();
  });
});

describe('_internal.dropTeenDocuments — rule #1 teen gate (age-derived, not a flag)', () => {
  // Fixed clock. 156 completed months = the teenager boundary (deriveStage).
  const NOW = new Date('2026-07-08T12:00:00.000Z');
  // Born 2013-01-08 → 162 completed months on NOW → teenager (>= 156mo).
  const TEEN_CHILD = { id: 'teen-child', dateOfBirth: '2013-01-08' };
  // Born 2025-01-08 → 18 completed months on NOW → toddler.
  const TODDLER_CHILD = { id: 'toddler-child', dateOfBirth: '2025-01-08' };

  const UPLOADER = 'parent-uploader';
  const OTHER_PARENT = 'parent-other';

  const teenDoc = { id: 'd1', childId: 'teen-child', authoredBy: UPLOADER };
  const toddlerDoc = { id: 'd2', childId: 'toddler-child', authoredBy: UPLOADER };
  const unattributedDoc = { id: 'd3', childId: null, authoredBy: UPLOADER };

  it("DROPS a teen-attributed doc for a NON-uploader parent", () => {
    const kept = _internal.dropTeenDocuments(
      [teenDoc, toddlerDoc],
      [TEEN_CHILD, TODDLER_CHILD],
      OTHER_PARENT,
      NOW,
    );
    expect(kept.map((d) => d.id)).toEqual(['d2']);
  });

  it("KEEPS the SAME teen doc for its uploader (authoredBy === requester)", () => {
    const kept = _internal.dropTeenDocuments(
      [teenDoc, toddlerDoc],
      [TEEN_CHILD, TODDLER_CHILD],
      UPLOADER,
      NOW,
    );
    expect(kept.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('keeps a toddler-attributed doc for anyone (non-uploader too)', () => {
    const kept = _internal.dropTeenDocuments([toddlerDoc], [TEEN_CHILD, TODDLER_CHILD], OTHER_PARENT, NOW);
    expect(kept.map((d) => d.id)).toEqual(['d2']);
  });

  it('DROPS an unattributed (childId null) doc for a non-uploader when the family has a teen', () => {
    const kept = _internal.dropTeenDocuments(
      [unattributedDoc],
      [TEEN_CHILD, TODDLER_CHILD],
      OTHER_PARENT,
      NOW,
    );
    expect(kept).toEqual([]);
  });

  it('KEEPS an unattributed doc for a non-uploader when the family has NO teen', () => {
    const kept = _internal.dropTeenDocuments(
      [unattributedDoc],
      [TODDLER_CHILD],
      OTHER_PARENT,
      NOW,
    );
    expect(kept.map((d) => d.id)).toEqual(['d3']);
  });
});
