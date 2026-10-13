export const PAGE_FETCH_TIMEOUT_MS = 15_000;
export const MAX_PAGE_BYTES = 4_000_000;
export const MAX_PAGE_TEXT_CHARS = 200_000;
export type FetchPage = (url: string) => Promise<string>;
const PAGE_FETCH_HEADERS = { Accept: 'text/html,application/xhtml+xml' } as const;

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&pound;/g, '£')
    .replace(/&euro;/g, '€')
    .replace(/&yen;/g, '¥')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function createFetchBody(timeoutMs = PAGE_FETCH_TIMEOUT_MS): FetchPage {
  return async (url: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: PAGE_FETCH_HEADERS,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`page fetch ${url} → HTTP ${res.status}`);
      }
      // THE DECLARED LENGTH FIRST, so a body too large to be a page is refused before it
      // is buffered. This primitive runs inside an inbound SMS turn on a URL a parent
      // pasted, and an origin that answers with a video would otherwise pull the whole
      // thing into memory to be told it was too big. The read below stays as the ceiling
      // for every origin that declares no length at all — most of them, under chunked
      // transfer encoding — so nothing here is a substitute for it.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
        throw new Error(
          `page fetch ${url} → ${declared} chars exceeds the ${MAX_PAGE_BYTES} page ceiling`,
        );
      }
      const body = await res.text();
      if (body.length > MAX_PAGE_BYTES) {
        throw new Error(
          `page fetch ${url} → ${body.length} chars exceeds the ${MAX_PAGE_BYTES} page ceiling`,
        );
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createFetchPage(timeoutMs = PAGE_FETCH_TIMEOUT_MS): FetchPage {
  const fetchBody = createFetchBody(timeoutMs);
  return async (url: string) => {
    // Strip FIRST, then bound. Bounding the markup throws away the dates it was
    // wrapped in; bounding the text bounds what the model actually reads.
    const text = stripHtml(await fetchBody(url));
    return text.length > MAX_PAGE_TEXT_CHARS ? text.slice(0, MAX_PAGE_TEXT_CHARS) : text;
  };
}

export function pageCache(fetchPage: FetchPage) {
  const cache = new Map<string, Promise<string>>();
  return (url: string): Promise<string> => {
    const existing = cache.get(url);
    if (existing) return existing;
    const pending = fetchPage(url);
    cache.set(url, pending);
    return pending;
  };
}
