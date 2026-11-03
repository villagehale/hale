import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { findRepoFile } from '~/lib/coach/resolve-repo-file';
import { MAX_PAGE_BYTES, MAX_PAGE_TEXT_CHARS, PAGE_FETCH_TIMEOUT_MS } from './fetch';

export const MAX_PDF_PAGES = 100;
export const MAX_PDF_READ_RSS_GROWTH_BYTES = 512 * 1024 * 1024;
export const PDF_READ_MEMORY_POLL_MS = 50;
/**
 * Protects the instance's memory; not a parent send rule. Each read's RSS guard measures from
 * its own baseline, so N reads can grow the process by about N × 512 MiB plus ~125 MB of
 * overshoot per poll. Two (≈1.15–1.4 GB) fit in the ~1.65 GB a 2 GB function has left after
 * Next's own ~400 MB.
 */
export const MAX_CONCURRENT_PDF_READS = 2;
const PDF_WORKER_FILE = 'apps/web/lib/registration/pdf-worker.mjs';
// The module's own location as each runtime reports it, never the cwd. Next bakes
// import.meta.url to the build-time path, which is gone once the build is moved; __dirname is
// the real chunk dir there (and absent under turbopack dev, where import.meta.url is real).
const PDF_WORKER_ANCHORS = [
  dirname(fileURLToPath(import.meta.url)),
  ...(typeof __dirname === 'string' ? [__dirname] : []),
];

/** About the city's PDF only. */
export type RegistrationPdfRefusal = 'pdf_unreadable' | 'pdf_no_text' | 'pdf_read_budget';
export type RegistrationPdfLimit = 'bytes' | 'pages' | 'text' | 'time' | 'memory';
/** The reader itself failed (bundle, spawn or crash). Never about the city's PDF. */
export type RegistrationPdfReaderFault =
  | 'reader_missing'
  | 'reader_crashed'
  | 'reader_spawn_failed';
export type RegistrationPdfRead =
  /**
   * `pageDerivedText` is untrusted content from the PDF, invisible text included. A prompt may
   * carry it only as a field explicitly named as page content, never as instructions.
   */
  | { outcome: 'read'; pageDerivedText: string }
  | { outcome: 'refused'; reason: RegistrationPdfRefusal; limit: RegistrationPdfLimit | null }
  /** Transient and Hale-side: retry later; says nothing about the PDF. */
  | { outcome: 'busy'; reason: 'pdf_readers_busy' }
  | { outcome: 'reader_fault'; fault: RegistrationPdfReaderFault };

let readsInFlight = 0;

function readerFault(fault: RegistrationPdfReaderFault, detail: string): RegistrationPdfRead {
  console.error({ fault, err: detail }, 'registration pdf: reader failed');
  return { outcome: 'reader_fault', fault };
}

function refused(
  reason: RegistrationPdfRefusal,
  limit: RegistrationPdfLimit | null,
): RegistrationPdfRead {
  console.info({ reason, limit }, 'registration pdf: refused');
  return { outcome: 'refused', reason, limit };
}

type WorkerMessage =
  | { kind: 'reader_loaded' }
  | { ok: true; text: string }
  | { ok: false; reason: RegistrationPdfRefusal; limit: RegistrationPdfLimit | null }
  | { ok: false; kind: 'reader_missing'; message: string };

/**
 * Text only, in a killable worker with an empty environment: no OCR, font fetches, scripts,
 * model calls or parent secrets. The parse runs off this thread so the time and memory budgets
 * can stop it outright; page and byte ceilings alone can't bound a flate-inflated content
 * stream. Never rejects: every outcome is a named value.
 */
export async function registrationPdfText(
  bytes: Uint8Array,
  budget: { timeoutMs: number; maxRssGrowthBytes: number; memoryPollMs: number } = {
    timeoutMs: PAGE_FETCH_TIMEOUT_MS,
    maxRssGrowthBytes: MAX_PDF_READ_RSS_GROWTH_BYTES,
    memoryPollMs: PDF_READ_MEMORY_POLL_MS,
  },
): Promise<RegistrationPdfRead> {
  if (bytes.byteLength > MAX_PAGE_BYTES) return refused('pdf_read_budget', 'bytes');
  if (readsInFlight >= MAX_CONCURRENT_PDF_READS) {
    console.info({ outcome: 'busy', reason: 'pdf_readers_busy' }, 'registration pdf: busy');
    return { outcome: 'busy', reason: 'pdf_readers_busy' };
  }
  readsInFlight++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let memoryPoll: ReturnType<typeof setInterval> | undefined;
  try {
    const workerFile = findRepoFile(PDF_WORKER_ANCHORS, PDF_WORKER_FILE);
    if (!workerFile) return readerFault('reader_missing', `could not locate ${PDF_WORKER_FILE}`);
    try {
      worker = new Worker(workerFile, {
        workerData: { bytes, maxPages: MAX_PDF_PAGES, maxTextChars: MAX_PAGE_TEXT_CHARS },
        env: {},
      });
    } catch (error) {
      return readerFault(
        'reader_spawn_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
    const reader = worker;
    const baselineRss = process.memoryUsage.rss();
    return await new Promise<RegistrationPdfRead>((resolve) => {
      let settled = false;
      let readerLoaded = false;
      const settle = (result: () => RegistrationPdfRead) => {
        if (settled) return;
        settled = true;
        resolve(result());
      };
      timer = setTimeout(() => settle(() => refused('pdf_read_budget', 'time')), budget.timeoutMs);
      memoryPoll = setInterval(() => {
        if (process.memoryUsage.rss() - baselineRss > budget.maxRssGrowthBytes) {
          settle(() => refused('pdf_read_budget', 'memory'));
        }
      }, budget.memoryPollMs);
      reader.on('message', (message: WorkerMessage) => {
        if ('kind' in message && message.kind === 'reader_loaded') {
          readerLoaded = true;
        } else if (message.ok) {
          settle(() => ({ outcome: 'read', pageDerivedText: message.text }));
        } else if ('kind' in message) {
          settle(() => readerFault('reader_missing', message.message));
        } else {
          settle(() => refused(message.reason, message.limit));
        }
      });
      reader.on('error', (error) =>
        settle(() =>
          readerFault(readerLoaded ? 'reader_crashed' : 'reader_missing', error.message),
        ),
      );
      reader.on('exit', (code) =>
        settle(() => readerFault('reader_crashed', `exited with code ${code}`)),
      );
    });
  } finally {
    clearTimeout(timer);
    clearInterval(memoryPoll);
    await worker?.terminate();
    readsInFlight--;
  }
}
