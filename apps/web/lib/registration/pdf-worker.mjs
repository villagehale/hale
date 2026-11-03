// Runs in a worker thread so the parent can kill a parse that never yields: in Node,
// pdf.js parses on the calling thread, where no timer can preempt it.
import { parentPort, workerData } from 'node:worker_threads';

const { bytes, maxPages, maxTextChars } = workerData;

let getDocument;
let VerbosityLevel;
try {
  ({ getDocument, VerbosityLevel } = await import('unpdf/pdfjs'));
} catch (error) {
  parentPort.postMessage({
    ok: false,
    kind: 'reader_missing',
    message: error instanceof Error ? error.message : String(error),
  });
}

if (getDocument) {
  parentPort.postMessage({ kind: 'reader_loaded' });
  parentPort.postMessage(await read());
}

async function read() {
  const loadingTask = getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > maxPages) return refusal('pdf_read_budget', 'pages');
    let text = '';
    let hasText = false;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .flatMap((item) => ('str' in item ? [item.str + (item.hasEOL ? '\n' : '')] : []))
        .join('');
      hasText ||= pageText.trim().length > 0;
      text += `[PDF page ${pageNumber}]\n${pageText}\n`;
      page.cleanup();
      if (text.length > maxTextChars) return refusal('pdf_read_budget', 'text');
    }
    if (!hasText) return refusal('pdf_no_text', null);
    return { ok: true, text: text.replace(/\s+/g, ' ').trim() };
  } catch {
    return refusal('pdf_unreadable', null);
  } finally {
    await loadingTask.destroy();
  }
}

function refusal(reason, limit) {
  return { ok: false, reason, limit };
}
