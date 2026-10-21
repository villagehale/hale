import { MAX_PAGE_BYTES, MAX_PAGE_TEXT_CHARS, PAGE_FETCH_TIMEOUT_MS } from './fetch';

export class RegistrationPdfError extends Error {
  constructor(readonly reason: 'pdf_unreadable' | 'pdf_no_text' | 'pdf_read_budget') {
    super(reason);
  }
}

/** Text only: no OCR, external font fetches, embedded scripts or model calls. */
export async function registrationPdfText(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_PAGE_BYTES) throw new RegistrationPdfError('pdf_read_budget');
  const deadline = Date.now() + PAGE_FETCH_TIMEOUT_MS;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const { getDocument } = await import('unpdf/pdfjs');
    // Copy: PDF.js may transfer its input; the operation cache must retain the original bytes.
    const loadingTask = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      maxImageSize: 16_777_216,
      stopAtErrors: true,
    });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > 100) throw new RegistrationPdfError('pdf_read_budget');
      let text = '';
      let hasText = false;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        if (expired || Date.now() > deadline) throw new RegistrationPdfError('pdf_read_budget');
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items
          .flatMap((item) => ('str' in item ? [item.str + (item.hasEOL ? '\n' : '')] : []))
          .join('');
        hasText ||= pageText.trim().length > 0;
        text += `[PDF page ${pageNumber}]\n${pageText}\n`;
        page.cleanup();
        if (text.length > MAX_PAGE_TEXT_CHARS) throw new RegistrationPdfError('pdf_read_budget');
      }
      if (!hasText) throw new RegistrationPdfError('pdf_no_text');
      return text.replace(/\s+/g, ' ').trim();
    } finally {
      await loadingTask.destroy();
    }
  };
  try {
    // shortcut: a deadline cannot preempt synchronous PDF.js CPU; use a worker for a hard CPU limit.
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new RegistrationPdfError('pdf_read_budget'));
        }, PAGE_FETCH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof RegistrationPdfError) throw error;
    throw new RegistrationPdfError('pdf_unreadable');
  } finally {
    clearTimeout(timer);
  }
}
