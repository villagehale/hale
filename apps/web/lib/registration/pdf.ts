import { Worker } from 'node:worker_threads';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';
import { MAX_PAGE_BYTES, MAX_PAGE_TEXT_CHARS, PAGE_FETCH_TIMEOUT_MS } from './fetch';

export const MAX_PDF_PAGES = 100;
export const MAX_PDF_READ_RSS_GROWTH_BYTES = 512 * 1024 * 1024;
export const PDF_READ_MEMORY_POLL_MS = 50;
const PDF_WORKER_FILE = 'apps/web/lib/registration/pdf-worker.mjs';

export type RegistrationPdfRefusal = 'pdf_unreadable' | 'pdf_no_text' | 'pdf_read_budget';
export type RegistrationPdfLimit = 'bytes' | 'pages' | 'text' | 'time' | 'memory';

export class RegistrationPdfError extends Error {
  constructor(
    readonly reason: RegistrationPdfRefusal,
    readonly limit: RegistrationPdfLimit | null = null,
  ) {
    super(limit ? `${reason}:${limit}` : reason);
  }
}

/** The reader itself failed (bundle or crash). Never about the city's PDF. */
export type RegistrationPdfReaderFault = 'reader_missing' | 'reader_crashed';
export class RegistrationPdfReaderError extends Error {
  constructor(
    readonly fault: RegistrationPdfReaderFault,
    detail: string,
  ) {
    super(`${fault}: ${detail}`);
  }
}

function readerFault(fault: RegistrationPdfReaderFault, detail: string) {
  console.error({ fault, err: detail }, 'registration pdf: reader failed');
  return new RegistrationPdfReaderError(fault, detail);
}

type WorkerMessage =
  | { kind: 'reader_loaded' }
  | { ok: true; text: string }
  | { ok: false; reason: RegistrationPdfRefusal; limit: RegistrationPdfLimit | null }
  | { ok: false; kind: 'reader_missing'; message: string };

/**
 * Text only, in a killable worker: no OCR, font fetches, scripts or model calls.
 * The parse runs off this thread so the time and memory budgets can stop it outright;
 * page and byte ceilings alone can't bound a flate-inflated content stream.
 */
export async function registrationPdfText(
  bytes: Uint8Array,
  budget: { timeoutMs: number; maxRssGrowthBytes: number } = {
    timeoutMs: PAGE_FETCH_TIMEOUT_MS,
    maxRssGrowthBytes: MAX_PDF_READ_RSS_GROWTH_BYTES,
  },
): Promise<string> {
  if (bytes.byteLength > MAX_PAGE_BYTES) throw new RegistrationPdfError('pdf_read_budget', 'bytes');
  let workerFile: string;
  try {
    workerFile = resolveRepoFile(PDF_WORKER_FILE);
  } catch (error) {
    throw readerFault('reader_missing', error instanceof Error ? error.message : String(error));
  }
  const worker = new Worker(workerFile, {
    workerData: { bytes, maxPages: MAX_PDF_PAGES, maxTextChars: MAX_PAGE_TEXT_CHARS },
  });
  const baselineRss = process.memoryUsage.rss();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let memoryPoll: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let readerLoaded = false;
      const settle = (settleWith: () => void) => {
        if (settled) return;
        settled = true;
        settleWith();
      };
      const readerFailed = (fault: RegistrationPdfReaderFault, detail: string) =>
        settle(() => reject(readerFault(fault, detail)));
      timer = setTimeout(
        () => settle(() => reject(new RegistrationPdfError('pdf_read_budget', 'time'))),
        budget.timeoutMs,
      );
      memoryPoll = setInterval(() => {
        if (process.memoryUsage.rss() - baselineRss > budget.maxRssGrowthBytes) {
          settle(() => reject(new RegistrationPdfError('pdf_read_budget', 'memory')));
        }
      }, PDF_READ_MEMORY_POLL_MS);
      worker.on('message', (message: WorkerMessage) => {
        if ('kind' in message && message.kind === 'reader_loaded') {
          readerLoaded = true;
        } else if (message.ok) {
          settle(() => resolve(message.text));
        } else if ('kind' in message) {
          readerFailed('reader_missing', message.message);
        } else {
          settle(() => reject(new RegistrationPdfError(message.reason, message.limit)));
        }
      });
      worker.on('error', (error) =>
        readerFailed(readerLoaded ? 'reader_crashed' : 'reader_missing', error.message),
      );
      worker.on('exit', (code) => readerFailed('reader_crashed', `exited with code ${code}`));
    });
  } finally {
    clearTimeout(timer);
    clearInterval(memoryPoll);
    await worker.terminate();
  }
}
