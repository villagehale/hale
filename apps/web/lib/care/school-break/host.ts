/**
 * VIL-685 · the code check that a calendar page is the board's own.
 *
 * The OFFICIAL HOST is the board's or school's own website host, as Wikidata states it
 * (official-board.ts), reached from the school mail Hale already read. A page served from
 * that host, or from a subdomain of it, is the board's own page. Anything else — a news
 * site, a holiday-listing site, a neighbouring board — is not, whatever it says.
 */

/** The URL is https and served from `officialHost` or one of its subdomains. */
export function onOfficialHost(url: string, officialHost: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === officialHost || host.endsWith(`.${officialHost}`);
}
