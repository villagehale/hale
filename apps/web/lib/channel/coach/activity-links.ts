/**
 * The pages behind the finds a reply cites, attached by reference.
 *
 * STRUCTURAL, NOT WORD MATCHING. Every find a tool hands the model this turn that has a
 * page carries a `ref` (see `linkRef`) instead of its URL. When the reply is about that
 * exact program, the model writes the ref in square brackets (`[link-1a2b3c]`); code
 * removes the marker and appends that find's URL. A URL the model typed itself is
 * dropped, whatever it says, because the only way a page reaches a parent is a ref that
 * a tool returned this turn. An unknown ref is dropped too. Nothing here reads titles,
 * venues or words.
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
    if (url && isAbsoluteHttps(url) && !urls.includes(url)) urls.push(url);
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

const ABSOLUTE_HTTPS = /^https:\/\/\S+$/i;
/** The machinery word, as its own word. "refer" and "referral" do not match. */
const REF_WORD = /\brefs?\b/i;
/** The other half of the same narration: explaining that a page can be attached. */
const ATTACH_PAGE = /\battach(?:es|ed|ing)?\s+(?:the|a|that|their|its)\s+page\b/i;
/** Periods that are not sentence ends, so "St. Lawrence" survives a sentence split. */
const ABBREVIATION = /\b(?:St|Mr|Mrs|Ms|Dr|Jr|Sr|a\.m|p\.m|e\.g|i\.e)\./gi;

function isAbsoluteHttps(url: string): boolean {
  return ABSOLUTE_HTTPS.test(url.trim());
}

/**
 * VIL-501. Parent-visible talk about the marker. The bracket token itself is not this:
 * code removes it before the parent reads the reply. "refer" is a different word.
 */
export function narratesRefMachinery(text: string): boolean {
  return REF_WORD.test(text) || ATTACH_PAGE.test(text);
}

function sentences(text: string): string[] {
  const shielded = text.replace(ABBREVIATION, (match) => `${match.slice(0, -1)}\u0001`);
  return shielded
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.replaceAll('\u0001', '.').trim())
    .filter((part) => part !== '');
}

/**
 * Drop every sentence that explains the marker. A reply that was only that comes back
 * empty — the caller fails the turn. Nothing here writes a replacement sentence.
 */
export function stripRefNarration(text: string): string {
  const trimmed = text.trim();
  if (!narratesRefMachinery(trimmed)) return trimmed;
  return sentences(trimmed)
    .filter((sentence) => !narratesRefMachinery(sentence))
    .join(' ')
    .trim();
}

/**
 * After refs are resolved. Narration never stays. Cited pages stay only when they are
 * absolute https. An empty body is the caller's to fail — this function does not
 * compose a class, a source line, or any other stand-in.
 */
export function repairParentReply(
  body: string,
  citedUrls: readonly string[],
): { body: string; urls: string[] } {
  const urls = citedUrls.filter((url) => isAbsoluteHttps(url));
  const trimmed = body.trim();
  if (!narratesRefMachinery(trimmed)) return { body: trimmed, urls };
  return { body: stripRefNarration(trimmed), urls };
}
