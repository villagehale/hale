/**
 * A Browser Use live-view link is a bearer credential: whoever holds it drives a
 * browser holding the parent's provider session and cart. Two rules hold it:
 *
 * - Hale accepts a live view only on Browser Use's own live-view host
 *   (docs.browser-use.com/cloud/browser/live-preview), so a spoofed or malformed
 *   upstream value never reaches a parent as a trusted link.
 * - Conversation history never stores one. Every later coach turn re-reads the
 *   thread, and the thread outlives the browser.
 */
export const BROWSER_USE_LIVE_VIEW_HOST = 'live.browser-use.com';

/** What history keeps where a live-view link was. Model context only, never sent. */
export const LIVE_VIEW_LINK_WITHHELD = '[live browser link, not kept]';

export function liveViewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === BROWSER_USE_LIVE_VIEW_HOST &&
      url.username === '' &&
      url.password === ''
      ? url.href
      : null;
  } catch {
    return null;
  }
}

// A tab or newline inside the host is dropped by the URL parser, so the host
// tolerates one between any two characters.
const HOST_PATTERN = [...BROWSER_USE_LIVE_VIEW_HOST]
  .map((c) => c.replace(/\./, '\\.'))
  .join('[\\t\\n\\r]*');
// The host with or without a scheme, then any URL characters (RFC 3986 plus `%`), and
// the tab, CR and LF the parser drops from anywhere in a link. Text in other scripts
// right after the link is kept.
const LIVE_VIEW_LINK = new RegExp(
  `(?:https?://)?${HOST_PATTERN}(?::\\d+)?[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%\\t\\r\\n]*`,
  'gi',
);

// What the URL parser drops from a host: format characters (zero-width space,
// soft hyphen, BOM...), variation selectors and the combining grapheme joiner.
const PARSER_IGNORED = /\p{Cf}|\p{Variation_Selector}|\u034F/gu;
const IDEOGRAPHIC_FULL_STOP = /[\u3002\uFF61]/g;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const DECODED_HOST_SAFE = /^[A-Za-z0-9._~\-\u0080-\u{10FFFF}]*$/u;

function decodeHostEscapes(run: string): string {
  try {
    const decoded = decodeURIComponent(run);
    return DECODED_HOST_SAFE.test(decoded) && !/\s/u.test(decoded) ? decoded : run;
  } catch (error) {
    if (error instanceof URIError) return run;
    throw error;
  }
}

/** Reads the text the way the URL parser reads a host. */
function asParserReads(text: string): string {
  return text
    .replace(PERCENT_RUN, decodeHostEscapes)
    .normalize('NFKC')
    .replace(PARSER_IGNORED, '')
    .replace(IDEOGRAPHIC_FULL_STOP, '.')
    .replace(/\\/g, '/');
}

/**
 * Matches on the parser's reading, so every spelling the pin would accept is
 * caught. A text with no live-view link comes back exactly as it was; one with a
 * link is stored in that reading.
 */
export function withoutLiveViewLinks(text: string): string {
  const read = asParserReads(text);
  LIVE_VIEW_LINK.lastIndex = 0;
  if (!LIVE_VIEW_LINK.test(read)) return text;
  return read.replace(LIVE_VIEW_LINK, LIVE_VIEW_LINK_WITHHELD);
}
