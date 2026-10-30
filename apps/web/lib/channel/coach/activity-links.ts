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
    if (url && !urls.includes(url)) urls.push(url);
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

/**
 * VIL-501. A pick the tool actually returned, so a reply that narrated the marker can
 * be replaced with the class and — only when the tool had one — that page. No field
 * here is invented. `url` is absent when the page was not an absolute http(s) address.
 */
export interface ClassFact {
  name: string;
  ageFit?: string | null;
  when?: string | null;
  price?: string | null;
  sourceName?: string | null;
  url?: string | null;
}

const PARENT_URL = /^https?:\/\/\S+$/i;
/** The machinery word, as its own word. "refer" and "referral" do not match. */
const REF_WORD = /\brefs?\b/i;
/** "I can attach the page" — the other half of the same narration, with or without "ref". */
const ATTACH_PAGE = /\battach(?:es|ed|ing)?\s+(?:the|a|that|their|its)\s+page\b/i;
/** Periods that are not sentence ends, so "St. Lawrence" survives a sentence split. */
const ABBREVIATION = /\b(?:St|Mr|Mrs|Ms|Dr|Jr|Sr|a\.m|p\.m|e\.g|i\.e)\./gi;

/** An absolute http(s) page with no spaces. Anything else is not a link we will text. */
export function parentPageUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim() ?? '';
  return PARENT_URL.test(trimmed) ? trimmed : null;
}

export function classFactFromPick(pick: {
  name: string;
  ageFit?: string | null;
  when?: string | null;
  price?: string | null;
  sourceName?: string | null;
  url?: string | null;
}): ClassFact {
  const url = parentPageUrl(pick.url);
  return {
    name: pick.name.trim(),
    ageFit: pick.ageFit?.trim() || null,
    when: pick.when?.trim() || null,
    price: pick.price?.trim() || null,
    sourceName: pick.sourceName?.trim() || null,
    ...(url ? { url } : {}),
  };
}

/** Offers the village ledger kept, then facts the web verb recorded. Same class once. */
export function classFactsFromTurn(
  offers: readonly {
    title: string;
    venue?: string;
    url?: string;
    ageFit?: string | null;
    when?: string | null;
    price?: string | null;
  }[],
  recorded: readonly ClassFact[] = [],
): ClassFact[] {
  const seen = new Set<string>();
  const out: ClassFact[] = [];
  for (const fact of [
    ...offers.map((offer) =>
      classFactFromPick({
        name: offer.title,
        sourceName: offer.venue ?? null,
        url: offer.url,
        ageFit: offer.ageFit,
        when: offer.when,
        price: offer.price,
      }),
    ),
    ...recorded,
  ]) {
    if (fact.name === '') continue;
    const key = `${fact.name.toLowerCase()}|${parentPageUrl(fact.url) ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

/** Parent-visible talk about the marker. The bracket token itself is not this. */
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

/** Drop every sentence that explains the marker. A reply that was only that comes back empty. */
export function stripRefNarration(text: string): string {
  const trimmed = text.trim();
  if (!narratesRefMachinery(trimmed)) return trimmed;
  return sentences(trimmed)
    .filter((sentence) => !narratesRefMachinery(sentence))
    .join(' ')
    .trim();
}

/**
 * One sentence per class, from fields the tool returned. The page address is NOT in
 * the sentence — callers append `urls`, and only those that are real http(s) pages.
 */
export function renderClassFacts(facts: readonly ClassFact[]): { body: string; urls: string[] } {
  const urls: string[] = [];
  const lines: string[] = [];
  for (const fact of classFactsFromTurn([], facts)) {
    const bits = [fact.name];
    if (fact.ageFit) bits.push(fact.ageFit);
    if (fact.when) bits.push(fact.when);
    if (fact.price) bits.push(fact.price);
    let line = bits.join(', ');
    if (fact.sourceName) line += `, per ${fact.sourceName}`;
    lines.push(`${line}.`);
    const url = parentPageUrl(fact.url);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return { body: lines.join(' '), urls };
}

function namesFact(body: string, name: string): boolean {
  const needle = name.trim().toLowerCase();
  return needle.length > 0 && body.toLowerCase().includes(needle);
}

/**
 * After refs are resolved. Narration never stays. When it was the whole reply, the
 * class facts stand in for it and their real pages ride along. A reply that already
 * said the class keeps that sentence; a named class gains its page if the tool had one.
 * A reply that never narrated is unchanged, including one that named a class and cited
 * nothing — attaching a page there would pick a link the model did not choose.
 */
export function repairParentReply(
  body: string,
  citedUrls: readonly string[],
  facts: readonly ClassFact[] | undefined,
): { body: string; urls: string[] } {
  const urls = [...citedUrls];
  const trimmed = body.trim();
  if (!narratesRefMachinery(trimmed)) return { body: trimmed, urls };
  const stripped = stripRefNarration(trimmed);
  const known = facts ?? [];
  if (stripped !== '') {
    for (const fact of known) {
      const url = parentPageUrl(fact.url);
      if (url && namesFact(stripped, fact.name) && !urls.includes(url)) urls.push(url);
    }
    return { body: stripped, urls };
  }
  const rendered = renderClassFacts(known);
  for (const url of urls) {
    if (parentPageUrl(url) && !rendered.urls.includes(url)) rendered.urls.push(url);
  }
  return { body: rendered.body, urls: rendered.urls };
}
