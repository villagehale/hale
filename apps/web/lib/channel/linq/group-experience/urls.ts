/**
 * Structural https URLs in a message. This is not intent detection: a token
 * either parses as https or it does not.
 */
export function httpsUrlsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s<>"'()[\]{},]+/)) {
    if (!token.toLowerCase().startsWith('https://')) continue;
    try {
      const url = new URL(token);
      if (url.protocol !== 'https:') continue;
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      out.push(url.href);
    } catch {
      // not a URL
    }
  }
  return out;
}
