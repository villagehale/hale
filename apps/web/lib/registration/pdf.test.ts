import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PAGE_BYTES, MAX_PAGE_TEXT_CHARS } from './fetch';
import { MAX_PDF_PAGES, PDF_READ_MEMORY_POLL_MS, registrationPdfText } from './pdf';
import { registrationPdfFixture, registrationPdfFlateFixture } from './pdf-fixture.test-helper';

// Spy-through: the real Worker runs; this only records when each one exits, because a read's
// slot frees on its worker's exit, which can trail the read's own result.
const exits = vi.hoisted(() => [] as Promise<number>[]);
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  class ExitRecordingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      exits.push(new Promise((resolve) => this.once('exit', resolve)));
    }
  }
  return { ...actual, Worker: ExitRecordingWorker };
});
const readersExited = () => Promise.all(exits);
afterEach(readersExited);

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

async function readText(...args: Parameters<typeof registrationPdfText>): Promise<string> {
  const result = await registrationPdfText(...args);
  expect(result.outcome).toBe('read');
  return result.outcome === 'read' ? result.pageDerivedText : '';
}

const refused = (reason: string, limit: string | null) => ({ outcome: 'refused', reason, limit });

describe('local registration PDF text extraction', () => {
  it('extracts real PDF bytes with page boundaries, not a binary UTF-8 string', async () => {
    const bytes = registrationPdfFixture(TWO_PAGE_GUIDE);
    const byteLength = bytes.byteLength;
    const text = await readText(bytes);
    expect(text).toContain('[PDF page 1]');
    expect(text).toContain('[PDF page 2]');
    expect(text).toContain('Winter registration begins November 10, 2026 at 9:00 a.m.');
    expect(text).not.toContain('%PDF-');
    expect(text).not.toContain('\n');
    expect(bytes.byteLength).toBe(byteLength);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('rejects malformed PDFs without trying to extract dates from their raw strings', async () => {
    await expect(registrationPdfText(Buffer.from('%PDF-1.4 broken'))).resolves.toEqual(
      refused('pdf_unreadable', null),
    );
  });

  it('does not treat an empty/image-only text layer as an unpublished date', async () => {
    await expect(registrationPdfText(registrationPdfFixture(['']))).resolves.toEqual(
      refused('pdf_no_text', null),
    );
    expect(await readText(registrationPdfFixture(['Session one opens soon']))).toContain(
      'Session one opens soon',
    );
  });

  it('refuses binary input over the byte ceiling before parsing, and parses at the ceiling', async () => {
    await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES + 1))).resolves.toEqual(
      refused('pdf_read_budget', 'bytes'),
    );
    await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES))).resolves.toEqual(
      refused('pdf_unreadable', null),
    );
  });

  it('bounds page count before reading every page', async () => {
    await expect(
      registrationPdfText(registrationPdfFixture(Array(MAX_PDF_PAGES + 1).fill('2026'))),
    ).resolves.toEqual(refused('pdf_read_budget', 'pages'));
    expect(await readText(registrationPdfFixture(Array(MAX_PDF_PAGES).fill('2026')))).toContain(
      `[PDF page ${MAX_PDF_PAGES}]`,
    );
  });

  it('refuses oversized extracted text instead of silently hiding later registration pages', async () => {
    const page = 'x'.repeat(3_000);
    const under = Math.floor(MAX_PAGE_TEXT_CHARS / CHARS_PER_TEXT_PAGE) - 5;
    const over = Math.floor(MAX_PAGE_TEXT_CHARS / CHARS_PER_TEXT_PAGE) + 5;
    expect(await readText(registrationPdfFixture(Array(under).fill(page)))).toContain(
      `[PDF page ${under}]`,
    );
    await expect(
      registrationPdfText(registrationPdfFixture(Array(over).fill(page))),
    ).resolves.toEqual(refused('pdf_read_budget', 'text'));
  });

  it('returns the text only as an explicitly page-derived field', async () => {
    const result = await registrationPdfText(registrationPdfFixture(TWO_PAGE_GUIDE));
    expect(result).toEqual({
      outcome: 'read',
      pageDerivedText:
        '[PDF page 1] Fall 2026. Preview August 3. [PDF page 2] Winter registration begins November 10, 2026 at 9:00 a.m.',
    });
    expect(Object.keys(result)).toEqual(['outcome', 'pageDerivedText']);
    expect(result).toHaveProperty('pageDerivedText');
    expect(result).not.toHaveProperty('text');
  });

  it('reads two PDFs at once and names a third busy (instance protection, not a send rule)', async () => {
    const guide = registrationPdfFixture(TWO_PAGE_GUIDE);
    const broken = Buffer.from('%PDF-1.4 broken');
    const outcomes = async (reads: ReturnType<typeof registrationPdfText>[]) =>
      (await Promise.all(reads)).map((result) => result.outcome);

    const reads = [
      registrationPdfText(guide),
      registrationPdfText(guide),
      registrationPdfText(guide),
    ];
    await expect(reads[2]).resolves.toEqual({ outcome: 'busy', reason: 'pdf_readers_busy' });
    expect(await outcomes(reads.slice(0, 2))).toEqual(['read', 'read']);

    await readersExited();
    expect(await outcomes([registrationPdfText(guide), registrationPdfText(guide)])).toEqual([
      'read',
      'read',
    ]);

    await readersExited();
    await expect(
      Promise.all([registrationPdfText(broken), registrationPdfText(broken)]),
    ).resolves.toEqual([refused('pdf_unreadable', null), refused('pdf_unreadable', null)]);
    await readersExited();
    expect(await outcomes([registrationPdfText(guide), registrationPdfText(guide)])).toEqual([
      'read',
      'read',
    ]);

    await readersExited();
    const inFlight = [registrationPdfText(guide), registrationPdfText(guide)];
    await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES + 1))).resolves.toEqual(
      refused('pdf_read_budget', 'bytes'),
    );
    expect(await outcomes(inFlight)).toEqual(['read', 'read']);
  });

  it('logs a refusal and a busy reader by name only, never any page text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const guide = registrationPdfFixture(TWO_PAGE_GUIDE);
      const reads = [registrationPdfText(guide), registrationPdfText(guide)];
      await expect(registrationPdfText(guide)).resolves.toEqual({
        outcome: 'busy',
        reason: 'pdf_readers_busy',
      });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenLastCalledWith(
        { outcome: 'busy', reason: 'pdf_readers_busy' },
        'registration pdf: busy',
      );
      await Promise.all(reads);
      await readersExited();

      await expect(registrationPdfText(registrationPdfFixture(['']))).resolves.toEqual(
        refused('pdf_no_text', null),
      );
      expect(info).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenLastCalledWith(
        { reason: 'pdf_no_text', limit: null },
        'registration pdf: refused',
      );
      await expect(registrationPdfText(new Uint8Array(MAX_PAGE_BYTES + 1))).resolves.toEqual(
        refused('pdf_read_budget', 'bytes'),
      );
      expect(info).toHaveBeenCalledTimes(3);
      expect(info).toHaveBeenLastCalledWith(
        { reason: 'pdf_read_budget', limit: 'bytes' },
        'registration pdf: refused',
      );

      const logged = JSON.stringify(info.mock.calls);
      expect(logged).toContain('pdf_readers_busy');
      for (const part of ['Winter registration', 'Preview August', '[PDF page']) {
        expect(logged).not.toContain(part);
      }
    } finally {
      info.mockRestore();
    }
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
      const outcome = await registrationPdfText(flateBomb, budget);
      const readCpu = cpuMicros(process.cpuUsage(readCpuStart));
      const elapsed = performance.now() - started;

      expect(outcome).toEqual(refused('pdf_read_budget', 'time'));
      expect(elapsed).toBeLessThan(budget.timeoutMs + 1_000);
      expect(readCpu).toBeGreaterThanOrEqual(0.5 * budget.timeoutMs * MICROS_PER_MS);

      // The read resolves before its worker stops; the kill is done once the worker exits.
      await readersExited();
      const afterKillStart = process.cpuUsage();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(cpuMicros(process.cpuUsage(afterKillStart))).toBeLessThan(300_000);

      // The control read gets the default budget: under CI load a cold worker can take longer than the bomb's 400 ms.
      expect(await readText(registrationPdfFixture(TWO_PAGE_GUIDE))).toContain(
        'Winter registration begins November 10, 2026',
      );
    }, 30_000);

    it('is killed when memory grows past the ceiling, long before the deadline', async () => {
      const budget = {
        timeoutMs: 20_000,
        maxRssGrowthBytes: MEMORY_CEILING_BYTES,
        memoryPollMs: PDF_READ_MEMORY_POLL_MS,
      };
      expect(memoryBomb.byteLength).toBeLessThanOrEqual(MAX_PAGE_BYTES);

      const started = performance.now();
      await expect(registrationPdfText(memoryBomb, budget)).resolves.toEqual(
        refused('pdf_read_budget', 'memory'),
      );
      expect(performance.now() - started).toBeLessThan(5_000);
      await readersExited();

      // The largest read the page and text ceilings allow, sampled every millisecond, so the
      // check runs dozens of times against an instance whose RSS is already far past the
      // ceiling: only growth since the read began may count.
      expect(process.memoryUsage.rss()).toBeGreaterThan(MEMORY_CEILING_BYTES);
      const largestLegalRead = registrationPdfFixture(
        Array(MAX_PDF_PAGES).fill('y'.repeat(LARGEST_LEGAL_PAGE_CHARS)),
      );
      expect(
        await readText(largestLegalRead, { ...budget, memoryPollMs: DENSE_MEMORY_POLL_MS }),
      ).toContain(`[PDF page ${MAX_PDF_PAGES}]`);
    }, 30_000);
  });
});
