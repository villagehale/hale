/**
 * The pages behind the finds a reply cites, attached by reference.
 *
 * STRUCTURAL, NOT WORD MATCHING. Every find a tool hands the model this turn that has a
 * page carries a `ref` (see `linkRef`) instead of its URL. When the reply is about that
 * exact program, the model writes the ref in square brackets (`[link-1a2b3c]`); code
 * removes the marker and appends that find's URL, and only when it is absolute https.
 * A URL the model typed itself is dropped, whatever it says, because the only way a
 * page reaches a parent is a ref that a tool returned this turn. An unknown ref is
 * dropped too. Nothing here reads titles, venues, or the word "ref".
 *
 * No imports. The coach-channel eval loads this file under tsx, where the `~/` alias
 * does not resolve.
 */

export interface RefLink {
  ref: string;
  url: string;
}

/**
 * A short, stable reference for a page: the same URL gets the same ref in a tool result
 * and in the runtime's link table, so the two never need to share a counter.
 * FNV-1a over the URL, six hex digits.
 */
export function linkRef(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `link-${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const REF_MARKER = /\[\s*(link-[0-9a-f]{6})\s*\]/gi;

/**
 * Split the model's text into the prose a parent reads and the pages its refs cite.
 * `body` has every typed URL and every ref marker removed; `urls` are the pages for the
 * refs that matched a link this turn, in the order the reply cited them, once each.
 */
export function attachLinks(
  text: string,
  links: readonly RefLink[] | undefined,
): { body: string; urls: string[] } {
  const byRef = new Map((links ?? []).map((link) => [link.ref.toLowerCase(), link.url]));
  const urls: string[] = [];
  const withoutRefs = text.replace(REF_MARKER, (_marker, ref: string) => {
    const url = byRef.get(ref.toLowerCase());
    // Only an absolute https page from this turn's table. http, a bare host, or a
    // non-URL never reaches a parent (VIL-501).
    // VIL-510: and only an activity or venue page, never an encyclopedia or a bare homepage.
    if (url && isActivityPageUrl(url) && !urls.includes(url)) urls.push(url);
    return ' ';
  });
  const body = withoutRefs
    // Trailing sentence punctuation belongs to the sentence, not the URL.
    .replace(URL_IN_TEXT, (url) => ` ${url.slice(url.replace(/[.,;:!?]+$/, '').length)}`)
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return { body, urls };
}

/** Absolute https only. http, a bare host, or a non-URL is not a page we text. */
const ABSOLUTE_HTTPS = /^https:\/\/\S+$/i;

function isAbsoluteHttps(url: string): boolean {
  return ABSOLUTE_HTTPS.test(url.trim());
}

/**
 * VIL-510 · Hosts that describe a place rather than publish what is on there. A parent asked
 * about trick-or-treat and was handed a Wikipedia preview of the town library: real page,
 * real tool result, and no use to anyone deciding where to go on Saturday.
 */
const REFERENCE_HOSTS = [
  'wikipedia.org',
  'wikimedia.org',
  'wikidata.org',
  'wikiwand.com',
  'wikivoyage.org',
  'wiktionary.org',
  'fandom.com',
  'britannica.com',
];

/**
 * VIL-510 · Whether a page may reach a parent as a link or a card: absolute https, not a
 * reference/encyclopedia host, and not a bare homepage (an org's front door says nothing
 * about the event or the session the reply is about). Structural only: host and path.
 */
export function isActivityPageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!isAbsoluteHttps(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (REFERENCE_HOSTS.some((ref) => host === ref || host.endsWith(`.${ref}`))) return false;
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  const homepage = ['', '/index', '/index.html', '/index.htm', '/index.php', '/home', '/en', '/fr'];
  if (homepage.includes(path) && parsed.search === '') return false;
  return true;
}
