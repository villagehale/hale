/**
 * VIL-685 · the code check that a calendar page is the board's own.
 *
 * The OFFICIAL HOST is the domain the family's school mail comes from: a sender the
 * family already said yes to on their forwarding address (`family_forward_senders`,
 * state `allowed`). Boards send from their own domain, so a page served from that domain,
 * or from a subdomain of it, is the board's own page. Anything else — a news site, a
 * holiday-listing site, a neighbouring board — is not, whatever it says.
 *
 * A host only: no path, no port, no credentials, lowercase, at least one dot. A bare
 * suffix (`ca`) cannot be an official host, so it can never widen to every site under it.
 */

const HOST =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A sender domain as an official host, or null when it is not a plain host name. */
export function officialHostOf(senderDomain: string): string | null {
  const host = senderDomain.trim().toLowerCase().replace(/\.$/, '');
  return HOST.test(host) ? host : null;
}

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
