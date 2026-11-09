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
      ? value
      : null;
  } catch {
    return null;
  }
}

const HOST_PATTERN = BROWSER_USE_LIVE_VIEW_HOST.replace(/\./g, '\\.');
// The host with or without a scheme, then any URL characters (RFC 3986 plus `%`).
// Text in other scripts right after the link is kept.
const LIVE_VIEW_LINK = new RegExp(
  `(?:https?://)?${HOST_PATTERN}(?::\\d+)?[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]*`,
  'gi',
);

export function withoutLiveViewLinks(text: string): string {
  return text.replace(LIVE_VIEW_LINK, LIVE_VIEW_LINK_WITHHELD);
}
