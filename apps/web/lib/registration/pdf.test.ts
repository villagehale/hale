import { describe, expect, it } from 'vitest';
import { MAX_PAGE_BYTES, MAX_PAGE_TEXT_CHARS } from './fetch';
import { registrationPdfText } from './pdf';
import { registrationPdfFixture } from './pdf-fixture.test-helper';

describe('local registration PDF text extraction', () => {
  it('extracts real PDF bytes with page boundaries, not a binary UTF-8 string', async () => {
    const text = await registrationPdfText(
      registrationPdfFixture([
        'Fall 2026. Preview August 3.',
        'Winter registration begins November 10, 2026 at 9:00 a.m.',
      ]),
    );
    expect(text).toContain('[PDF page 1]');
    expect(text).toContain('[PDF page 2]');
    expect(text).toContain('Winter registration begins November 10, 2026 at 9:00 a.m.');
    expect(text).not.toContain('%PDF-');
    expect(text).not.toContain('\n');
  });
  it('does not treat an empty/image-only text layer as an unpublished date', async () => {
    await expect(registrationPdfText(registrationPdfFixture(['']))).rejects.toMatchObject({
      reason: 'pdf_no_text',
    });
  });
  it('rejects malformed PDFs without trying to extract dates from their raw strings', async () => {
    await expect(registrationPdfText(Buffer.from('%PDF-1.4 broken'))).rejects.toMatchObject({
      reason: 'pdf_unreadable',
    });
  });
  it('bounds page count before reading every page', async () => {
    await expect(
      registrationPdfText(registrationPdfFixture(Array(101).fill('2026'))),
    ).rejects.toMatchObject({ reason: 'pdf_read_budget' });
  });
  it('refuses oversized binary input before parsing', async () => {
    await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES + 1))).rejects.toMatchObject({
      reason: 'pdf_read_budget',
    });
  });
  it('refuses oversized extracted text instead of silently hiding later registration pages', async () => {
    await expect(
      registrationPdfText(
        registrationPdfFixture(
          Array(60).fill('x'.repeat(Math.ceil(MAX_PAGE_TEXT_CHARS / 60) + 100)),
        ),
      ),
    ).rejects.toMatchObject({ reason: 'pdf_read_budget' });
  });
});
