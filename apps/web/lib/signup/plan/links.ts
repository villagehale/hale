/**
 * A link in any shape a phone would open: a scheme, `www.`, punycode, or a bare host with
 * any top-level domain ("bit.ly/x", "evil.app"). Read after NFKC, so full-width letters
 * and dots count. A TLD allowlist would miss every new TLD.
 */
const LINK = /https?:\/\/|www\.|xn--|[\p{L}\p{N}-]+\.\p{L}{2,}/iu;

export function hasLink(text: string): boolean {
  return LINK.test(text.normalize('NFKC'));
}

/** Page-sourced text with every word that holds a link dropped, before a model sees it. */
export function withoutLinks(text: string): string {
  return text
    .normalize('NFKC')
    .split(/\s+/)
    .filter((word) => word && !LINK.test(word))
    .join(' ');
}
