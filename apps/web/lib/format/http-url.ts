/**
 * An absolute http(s) URL, or null.
 *
 * The same fail-closed rule the public village card uses: javascript:, data:, and
 * relative paths are not links a parent can open.
 */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
}

/**
 * VIL-510 · A parent-facing activity/venue page URL, or null.
 *
 * Wikipedia and sister encyclopedia hosts are never a class or event page a
 * parent should open from a find. Generic http(s) still passes {@link safeHttpUrl};
 * this filter is only for links that ride a pick, card, or stamped source_url.
 */
export function parentFacingActivityUrl(raw: string | null | undefined): string | null {
  const url = safeHttpUrl(raw);
  if (url === null) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (
    host === 'wikipedia.org' ||
    host.endsWith('.wikipedia.org') ||
    host === 'wikimedia.org' ||
    host.endsWith('.wikimedia.org') ||
    host === 'wikidata.org' ||
    host.endsWith('.wikidata.org')
  ) {
    return null;
  }
  return url;
}
