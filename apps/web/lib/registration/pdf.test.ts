import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_PAGE_BYTES, MAX_PAGE_TEXT_CHARS } from './fetch';
import { MAX_PDF_PAGES, PDF_READ_MEMORY_POLL_MS, registrationPdfText } from './pdf';
import { registrationPdfFixture, registrationPdfFlateFixture } from './pdf-fixture.test-helper';

const TWO_PAGE_GUIDE = [
  'Fall 2026. Preview August 3.',
  'Winter registration begins November 10, 2026 at 9:00 a.m.',
];
// One 3,000-char page = 38 fixture lines of 80 chars, each ending in an EOL, plus the
// "[PDF page n]\n" marker and the trailing newline.
const CHARS_PER_TEXT_PAGE = 3_053;
const FLATE_BOMB_INFLATED_BYTES = 128 * 1024 * 1024;
// Calibrated: the largest legal read stays under the ceiling; this bomb grows it by ~965 MiB within
// 3 s even after the deadline test has already raised the process's RSS high-water mark,
// which freed-and-reused pages hide from a smaller bomb (128 MiB grows only ~36 MiB then).
const MEMORY_BOMB_INFLATED_BYTES = 512 * 1024 * 1024;
const MEMORY_CEILING_BYTES = 128 * 1024 * 1024;
const MICROS_PER_MS = 1_000;
// 100 pages of this stay just under MAX_PAGE_TEXT_CHARS once page markers are added.
const LARGEST_LEGAL_PAGE_CHARS = 1_900;
const DENSE_MEMORY_POLL_MS = 1;

function cpuMicros(usage: NodeJS.CpuUsage): number {
  return usage.user + usage.system;
}

describe('local registration PDF text extraction', () => {
  it('extracts real PDF bytes with page boundaries, not a binary UTF-8 string', async () => {
    const bytes = registrationPdfFixture(TWO_PAGE_GUIDE);
    const byteLength = bytes.byteLength;
    const text = await registrationPdfText(bytes);
    expect(text).toContain('[PDF page 1]');
    expect(text).toContain('[PDF page 2]');
    expect(text).toContain('Winter registration begins November 10, 2026 at 9:00 a.m.');
    expect(text).not.toContain('%PDF-');
    expect(text).not.toContain('\n');
    expect(bytes.byteLength).toBe(byteLength);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('rejects malformed PDFs without trying to extract dates from their raw strings', async () => {
    await expect(registrationPdfText(Buffer.from('%PDF-1.4 broken'))).rejects.toMatchObject({
      reason: 'pdf_unreadable',
      limit: null,
    });
  });

  it('does not treat an empty/image-only text layer as an unpublished date', async () => {
    await expect(registrationPdfText(registrationPdfFixture(['']))).rejects.toMatchObject({
      reason: 'pdf_no_text',
      limit: null,
    });
    await expect(
      registrationPdfText(registrationPdfFixture(['Session one opens soon'])),
    ).resolves.toContain('Session one opens soon');
  });

  it('refuses binary input over the byte ceiling before parsing, and parses at the ceiling', async () => {
    await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES + 1))).rejects.toMatchObject({
      reason: 'pdf_read_budget',
      limit: 'bytes',
    });
    await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES))).rejects.toMatchObject({
      reason: 'pdf_unreadable',
      limit: null,
    });
  });

  it('bounds page count before reading every page', async () => {
    await expect(
      registrationPdfText(registrationPdfFixture(Array(MAX_PDF_PAGES + 1).fill('2026'))),
    ).rejects.toMatchObject({ reason: 'pdf_read_budget', limit: 'pages' });
    await expect(
      registrationPdfText(registrationPdfFixture(Array(MAX_PDF_PAGES).fill('2026'))),
    ).resolves.toContain(`[PDF page ${MAX_PDF_PAGES}]`);
  });

  it('refuses oversized extracted text instead of silently hiding later registration pages', async () => {
    const page = 'x'.repeat(3_000);
    const under = Math.floor(MAX_PAGE_TEXT_CHARS / CHARS_PER_TEXT_PAGE) - 5;
    const over = Math.floor(MAX_PAGE_TEXT_CHARS / CHARS_PER_TEXT_PAGE) + 5;
    await expect(
      registrationPdfText(registrationPdfFixture(Array(under).fill(page))),
    ).resolves.toContain(`[PDF page ${under}]`);
    await expect(
      registrationPdfText(registrationPdfFixture(Array(over).fill(page))),
    ).rejects.toMatchObject({ reason: 'pdf_read_budget', limit: 'text' });
  });

  describe('a small file whose content stream inflates past every ceiling', () => {
    let flateBomb: Buffer;
    let memoryBomb: Buffer;
    beforeAll(() => {
      flateBomb = registrationPdfFlateFixture(FLATE_BOMB_INFLATED_BYTES);
      memoryBomb = registrationPdfFlateFixture(MEMORY_BOMB_INFLATED_BYTES);
    });

    it('is killed at the deadline, and burns no CPU after the kill', async () => {
      const budget = {
        timeoutMs: 400,
        maxRssGrowthBytes: Number.MAX_SAFE_INTEGER,
        memoryPollMs: PDF_READ_MEMORY_POLL_MS,
      };
      expect(flateBomb.byteLength).toBeLessThanOrEqual(MAX_PAGE_BYTES);

      const started = performance.now();
      const readCpuStart = process.cpuUsage();
      const outcome = await registrationPdfText(flateBomb, budget).catch((error: unknown) => error);
      const readCpu = cpuMicros(process.cpuUsage(readCpuStart));
      const elapsed = performance.now() - started;

      expect(outcome).toMatchObject({ reason: 'pdf_read_budget', limit: 'time' });
      expect(elapsed).toBeLessThan(budget.timeoutMs + 1_000);
      expect(readCpu).toBeGreaterThanOrEqual(0.5 * budget.timeoutMs * MICROS_PER_MS);

      const afterKillStart = process.cpuUsage();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(cpuMicros(process.cpuUsage(afterKillStart))).toBeLessThan(300_000);

      await expect(
        registrationPdfText(registrationPdfFixture(TWO_PAGE_GUIDE), budget),
      ).resolves.toContain('Winter registration begins November 10, 2026');
    }, 30_000);

    it('is killed when memory grows past the ceiling, long before the deadline', async () => {
      const budget = {
        timeoutMs: 20_000,
        maxRssGrowthBytes: MEMORY_CEILING_BYTES,
        memoryPollMs: PDF_READ_MEMORY_POLL_MS,
      };
      expect(memoryBomb.byteLength).toBeLessThanOrEqual(MAX_PAGE_BYTES);

      const started = performance.now();
      await expect(registrationPdfText(memoryBomb, budget)).rejects.toMatchObject({
        reason: 'pdf_read_budget',
        limit: 'memory',
      });
      expect(performance.now() - started).toBeLessThan(5_000);

      // The largest read the page and text ceilings allow, sampled every millisecond, so the
      // check runs dozens of times against an instance whose RSS is already far past the
      // ceiling: only growth since the read began may count.
      expect(process.memoryUsage.rss()).toBeGreaterThan(MEMORY_CEILING_BYTES);
      const largestLegalRead = registrationPdfFixture(
        Array(MAX_PDF_PAGES).fill('y'.repeat(LARGEST_LEGAL_PAGE_CHARS)),
      );
      await expect(
        registrationPdfText(largestLegalRead, { ...budget, memoryPollMs: DENSE_MEMORY_POLL_MS }),
      ).resolves.toContain(`[PDF page ${MAX_PDF_PAGES}]`);
    }, 30_000);
  });
});
